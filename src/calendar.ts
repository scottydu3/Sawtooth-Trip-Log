import type { Reminder, Stop } from "./types";
import { graph, GraphError } from "./graph";
import type { Store } from "./store";

interface GraphEvent {
  id: string;
  subject: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  lastModifiedDateTime: string;
  isCancelled?: boolean;
}

const utc = (iso: string) => new Date(iso).toISOString().replace("Z", "");
const fromGraph = (dt: string) => new Date(dt.endsWith("Z") ? dt : dt + "Z").toISOString();

function eventBody(r: Reminder, stop?: Stop) {
  const lines = [r.details || ""];
  if (stop) {
    lines.push("", "Stop: " + stop.name);
    if (stop.address) lines.push(stop.address);
    for (const c of stop.contacts || []) lines.push([c.name, c.role, c.phone, c.email].filter(Boolean).join(" · "));
  }
  lines.push("", "Added by Sawtooth Trip Log");
  const start = new Date(r.dueAt);
  const end = new Date(start.getTime() + (r.durationMin || 30) * 60000);
  return {
    subject: r.title,
    body: { contentType: "text", content: lines.join("\n").trim() },
    start: { dateTime: utc(start.toISOString()), timeZone: "UTC" },
    end: { dateTime: utc(end.toISOString()), timeZone: "UTC" },
    location: { displayName: stop ? [stop.name, stop.address, stop.city].filter(Boolean).join(", ") : "" },
    isReminderOn: true,
    reminderMinutesBeforeStart: 15,
    showAs: "free",
    categories: ["Sales trip"],
  };
}

/** Keeps each reminder mirrored as an Outlook calendar event. */
export class CalendarSync {
  enabled = false;
  deviceId = "";
  constructor(private store: Store) {}

  /** Create or update the Outlook event for one reminder. */
  async push(id: string) {
    if (!this.enabled) return;
    const r = this.store.get("reminders", id);
    if (!r) return;
    const stop = this.store.get("stops", r.stopId);
    const body = eventBody(r, stop);
    try {
      let ev: GraphEvent;
      if (r.eventId) {
        try {
          ev = (await graph<GraphEvent>("/me/events/" + encodeURIComponent(r.eventId), { method: "PATCH", body })).data;
        } catch (e) {
          if (!(e instanceof GraphError && e.status === 404)) throw e;
          ev = (await graph<GraphEvent>("/me/events", { method: "POST", body })).data;
        }
      } else {
        ev = (await graph<GraphEvent>("/me/events", { method: "POST", body })).data;
      }
      const cur = this.store.get("reminders", id);
      if (cur) this.store.put("reminders", id, { ...cur, eventId: ev.id, calStatus: "ok", calSyncedAt: ev.lastModifiedDateTime }, false);
    } catch {
      const cur = this.store.get("reminders", id);
      if (cur) this.store.put("reminders", id, { ...cur, calStatus: "error" }, false);
    }
  }

  async remove(eventId: string | undefined) {
    if (!this.enabled || !eventId) return;
    try { await graph("/me/events/" + encodeURIComponent(eventId), { method: "DELETE" }); } catch { /* already gone */ }
  }

  /**
   * Read back open reminders' events: a time or title changed in Outlook updates the app;
   * an event deleted in Outlook is flagged so it can be re-added. Reminders still waiting
   * to be written (created offline or after an error) are pushed.
   */
  async pullAll() {
    if (!this.enabled) return;
    const open = this.store.all("reminders").filter(([, r]) => !r.done);
    for (const [id, r] of open) {
      if (r.calStatus === "removed") continue;
      if (r.eventId && r.calStatus !== "error") continue;
      // A reminder made on another device gets its event from that device, unless it has been stuck a while.
      const stale = Date.now() - new Date(r.updatedAt).getTime() > 10 * 60000;
      if (r.eventId || !r.createdBy || r.createdBy === this.deviceId || stale) await this.push(id);
    }
    const linked = open.filter(([, r]) => r.eventId && r.calStatus === "ok");
    for (let i = 0; i < linked.length; i += 20) {
      const chunk = linked.slice(i, i + 20);
      const requests = chunk.map(([id, r]) => ({
        id, method: "GET",
        url: "/me/events/" + encodeURIComponent(r.eventId!) + "?$select=id,subject,start,end,lastModifiedDateTime,isCancelled",
        headers: { Prefer: 'outlook.timezone="UTC"' },
      }));
      let responses: { id: string; status: number; body: GraphEvent }[] = [];
      try { responses = (await graph<{ responses: typeof responses }>("/$batch", { method: "POST", body: { requests } })).data.responses; }
      catch { return; }
      for (const res of responses) {
        const r = this.store.get("reminders", res.id);
        if (!r) continue;
        if (res.status === 404 || (res.status === 200 && res.body.isCancelled)) {
          this.store.put("reminders", res.id, { ...r, calStatus: "removed", eventId: undefined });
        } else if (res.status === 200 && res.body.lastModifiedDateTime !== r.calSyncedAt) {
          const ev = res.body;
          const start = fromGraph(ev.start.dateTime);
          const dur = Math.max(5, Math.round((new Date(fromGraph(ev.end.dateTime)).getTime() - new Date(start).getTime()) / 60000));
          this.store.put("reminders", res.id, { ...r, title: ev.subject || r.title, dueAt: start, durationMin: dur, calSyncedAt: ev.lastModifiedDateTime });
        }
      }
    }
  }
}
