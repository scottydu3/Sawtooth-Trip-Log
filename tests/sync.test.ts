// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/auth", () => ({ getToken: async () => "token" }));

import { merge } from "../src/merge";
import { emptyData, type Reminder, type Stop } from "../src/types";
import { Store } from "../src/store";
import { CalendarSync } from "../src/calendar";

/** Minimal in-memory stand-in for the Graph endpoints the app uses. */
function fakeGraph() {
  const s = { file: null as string | null, etag: 0, events: new Map<string, any>(), seq: 0, calls: [] as string[] };
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(body === null ? null : JSON.stringify(body), { status, headers });
  const handle = (method: string, path: string, body: any, headers: Record<string, string>): Response => {
    s.calls.push(method + " " + path);
    if (path === "/me/drive/root:/Apps/SawtoothTripLog/trip-log.json") {
      return s.file === null ? json(404, { error: { message: "nf" } }) : json(200, { eTag: '"' + s.etag + '"', "@microsoft.graph.downloadUrl": "https://download.test/f" });
    }
    if (path.endsWith("trip-log.json:/content")) {
      if (headers["If-Match"] && headers["If-Match"] !== '"' + s.etag + '"') return json(412, { error: { message: "precondition" } });
      s.file = body; s.etag++;
      return json(200, { eTag: '"' + s.etag + '"' });
    }
    if (path === "/me/events" && method === "POST") {
      const id = "ev" + ++s.seq;
      const ev = { ...JSON.parse(body), id, lastModifiedDateTime: "m" + s.seq };
      s.events.set(id, ev);
      return json(201, ev);
    }
    const m = path.match(/^\/me\/events\/([^?]+)/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const ev = s.events.get(id);
      if (!ev) return json(404, { error: { message: "nf" } });
      if (method === "PATCH") { Object.assign(ev, JSON.parse(body), { lastModifiedDateTime: "m" + ++s.seq }); return json(200, ev); }
      if (method === "DELETE") { s.events.delete(id); return json(204, null); }
      return json(200, ev);
    }
    if (path === "/$batch") {
      const reqs = JSON.parse(body).requests;
      return json(200, { responses: reqs.map((r: any) => {
        const id = decodeURIComponent(r.url.match(/\/me\/events\/([^?]+)/)[1]);
        const ev = s.events.get(id);
        return ev ? { id: r.id, status: 200, body: ev } : { id: r.id, status: 404, body: {} };
      }) });
    }
    return json(500, { error: { message: "unhandled " + path } });
  };
  vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
    if (url === "https://download.test/f") return new Response(s.file, { status: 200 });
    const path = url.replace("https://graph.microsoft.com/v1.0", "");
    return handle(init.method || "GET", path, init.body, init.headers || {});
  });
  return s;
}

const stop = (o: Partial<Stop> = {}): Stop => ({ tripId: "t1", name: "Ace Hardware", kind: "", address: "1 Main St", city: "Boise", phone: "", website: "", status: "new", visitedOn: "2026-10-06", contacts: [], notes: [], createdAt: "2026-10-06T00:00:00Z", updatedAt: "2026-10-06T00:00:00Z", ...o });
const rem = (o: Partial<Reminder> = {}): Reminder => ({ stopId: "s1", tripId: "t1", title: "Call Dana", dueAt: "2026-10-09T15:00:00.000Z", durationMin: 30, details: "", done: false, createdAt: "x", updatedAt: "x", ...o });

beforeEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });

describe("merge", () => {
  it("keeps the newer record and honours newer deletes", () => {
    const a = emptyData(), b = emptyData();
    a.stops.s1 = stop({ name: "old", updatedAt: "2026-10-06T01:00:00Z" });
    b.stops.s1 = stop({ name: "new", updatedAt: "2026-10-06T02:00:00Z" });
    a.stops.s2 = stop({ updatedAt: "2026-10-06T01:00:00Z" });
    b.tombstones["stops/s2"] = "2026-10-06T03:00:00Z";
    b.stops.s3 = stop({ updatedAt: "2026-10-06T05:00:00Z" });
    a.tombstones["stops/s3"] = "2026-10-06T04:00:00Z"; // re-created after delete: record wins
    const m = merge(a, b);
    expect(m.stops.s1.name).toBe("new");
    expect(m.stops.s2).toBeUndefined();
    expect(m.stops.s3).toBeDefined();
  });
});

describe("OneDrive store", () => {
  it("creates the file, then merges edits from two devices", async () => {
    const g = fakeGraph();
    const phone = new Store();
    await phone.connectRemote();
    phone.put("stops", "s1", stop());
    await phone.push();
    expect(JSON.parse(g.file!).stops.s1.name).toBe("Ace Hardware");

    // Second device starts from an empty cache.
    localStorage.clear();
    const laptop = new Store();
    await laptop.connectRemote();
    expect(laptop.get("stops", "s1")?.name).toBe("Ace Hardware");

    // Both edit before syncing: laptop adds a stop, phone renames s1.
    laptop.put("stops", "s2", stop({ name: "Lumber Co" }));
    await laptop.push();
    phone.put("stops", "s1", { ...phone.get("stops", "s1")!, name: "Ace Hardware Boise" });
    await phone.push(); // gets 412, merges, retries
    const saved = JSON.parse(g.file!);
    expect(saved.stops.s1.name).toBe("Ace Hardware Boise");
    expect(saved.stops.s2.name).toBe("Lumber Co");
    expect(phone.sync).toBe("synced");
  });
});

describe("Outlook calendar sync", () => {
  it("creates, updates, reads back and deletes events", async () => {
    const g = fakeGraph();
    const store = new Store();
    const cal = new CalendarSync(store);
    cal.enabled = true; cal.deviceId = "d1";
    store.put("stops", "s1", stop({ contacts: [{ id: "c", name: "Dana Ruiz", role: "Owner", phone: "208-555-0142", email: "", notes: "" }] }));
    store.put("reminders", "r1", rem({ createdBy: "d1", calStatus: "pending" }));
    await cal.push("r1");
    let r = store.get("reminders", "r1")!;
    expect(r.calStatus).toBe("ok");
    const ev = g.events.get(r.eventId!);
    expect(ev.subject).toBe("Call Dana");
    expect(ev.start).toEqual({ dateTime: "2026-10-09T15:00:00.000", timeZone: "UTC" });
    expect(ev.end.dateTime).toBe("2026-10-09T15:30:00.000");
    expect(ev.body.content).toContain("Dana Ruiz · Owner · 208-555-0142");

    // Moved in Outlook to an hour later, 60 min long.
    ev.start = { dateTime: "2026-10-09T16:00:00.0000000", timeZone: "UTC" };
    ev.end = { dateTime: "2026-10-09T17:00:00.0000000", timeZone: "UTC" };
    ev.lastModifiedDateTime = "outlook-edit";
    await cal.pullAll();
    r = store.get("reminders", "r1")!;
    expect(r.dueAt).toBe("2026-10-09T16:00:00.000Z");
    expect(r.durationMin).toBe(60);

    // Deleted in Outlook.
    g.events.delete(r.eventId!);
    await cal.pullAll();
    expect(store.get("reminders", "r1")!.calStatus).toBe("removed");
    // Removed reminders are not silently re-created.
    await cal.pullAll();
    expect(g.events.size).toBe(0);
  });

  it("leaves a reminder made on another device to that device", async () => {
    const g = fakeGraph();
    const store = new Store();
    const cal = new CalendarSync(store);
    cal.enabled = true; cal.deviceId = "laptop";
    store.put("stops", "s1", stop());
    store.put("reminders", "r1", rem({ createdBy: "phone", calStatus: "pending" }));
    await cal.pullAll();
    expect(g.events.size).toBe(0);
  });
});
