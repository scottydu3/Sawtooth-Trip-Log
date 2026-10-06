import type { Contact, Stop } from "./types";
import { graph, GraphError } from "./graph";
import { CONTACT_SCOPES, ReconnectNeeded } from "./auth";
import type { Store } from "./store";

/*
 * Copies people met on stops into the user's Outlook contacts, which their phone can
 * sync (the Outlook app's "Save contacts" setting, or the work account in the phone's
 * own Contacts settings). Edits update the same Outlook entry; deleting a contact in
 * the app leaves the Outlook copy alone.
 */

function splitName(name: string): { givenName: string; surname: string } {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return { givenName: parts[0] || "", surname: "" };
  return { givenName: parts.slice(0, -1).join(" "), surname: parts[parts.length - 1] };
}

export function outlookContact(c: Contact, stop: Stop, state: string) {
  return {
    ...splitName(c.name),
    displayName: c.name || stop.name,
    companyName: stop.name,
    jobTitle: c.role || undefined,
    mobilePhone: c.phone || undefined,
    emailAddresses: c.email ? [{ address: c.email, name: c.name || c.email }] : [],
    businessAddress: { street: stop.address || "", city: stop.city || "", state, countryOrRegion: "United States" },
    personalNotes: [c.notes, "Added from Sawtooth Trip Log" + (stop.visitedOn ? ", visited " + stop.visitedOn : "")].filter(Boolean).join("\n"),
    categories: ["Sawtooth Trip Log"],
  };
}

export class ContactSync {
  enabled = false;
  /** Set when Microsoft refused because the Contacts permission isn't granted yet. */
  notPermitted = false;
  constructor(private store: Store, private stateOf: (s: Stop) => string, private isOn: () => boolean) {}

  async push(stopId: string, contactId: string) {
    if (!this.enabled || !this.isOn() || !navigator.onLine) return;
    const s = this.store.get("stops", stopId);
    const c = s?.contacts?.find((x) => x.id === contactId);
    if (!s || !c || !(c.name || c.phone || c.email)) return;
    const body = outlookContact(c, s, this.stateOf(s));
    let status: Contact["outlookStatus"] = "ok";
    let outlookId = c.outlookId;
    try {
      if (outlookId) {
        try { await graph("/me/contacts/" + encodeURIComponent(outlookId), { method: "PATCH", body, scopes: CONTACT_SCOPES }); }
        catch (e) { if (!(e instanceof GraphError && e.status === 404)) throw e; outlookId = undefined; }
      }
      if (!outlookId) outlookId = (await graph<{ id: string }>("/me/contacts", { method: "POST", body, scopes: CONTACT_SCOPES })).data.id;
      this.notPermitted = false;
    } catch (e) {
      status = "error";
      if (e instanceof ReconnectNeeded || (e instanceof GraphError && (e.status === 401 || e.status === 403))) this.notPermitted = true;
    }
    const cur = this.store.get("stops", stopId);
    if (!cur) return;
    this.store.put("stops", stopId, { ...cur, contacts: (cur.contacts || []).map((x) => (x.id === contactId ? { ...x, outlookId, outlookStatus: status } : x)) }, false);
  }

  /** Save contacts added offline, or that failed before (e.g. before the permission was granted). */
  async pushPending() {
    if (!this.enabled || !this.isOn()) return;
    for (const [sid, s] of this.store.all("stops")) {
      for (const c of s.contacts || []) if (c.outlookStatus === "pending" || c.outlookStatus === "error") await this.push(sid, c.id);
    }
  }
}

/** A vCard the phone can open to add the person to its contacts directly. */
export function vcard(c: Contact, stop: Stop, state: string): string {
  const e = (v: string) => v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");
  const n = splitName(c.name);
  return [
    "BEGIN:VCARD", "VERSION:3.0",
    "N:" + e(n.surname) + ";" + e(n.givenName) + ";;;",
    "FN:" + e(c.name || stop.name),
    "ORG:" + e(stop.name),
    c.role ? "TITLE:" + e(c.role) : "",
    c.phone ? "TEL;TYPE=CELL:" + e(c.phone) : "",
    c.email ? "EMAIL;TYPE=WORK:" + e(c.email) : "",
    stop.address || stop.city ? "ADR;TYPE=WORK:;;" + e(stop.address || "") + ";" + e(stop.city || "") + ";" + e(state) + ";;USA" : "",
    "NOTE:" + e([c.notes, "Sawtooth Trip Log"].filter(Boolean).join(" - ")),
    "END:VCARD",
  ].filter(Boolean).join("\r\n");
}
