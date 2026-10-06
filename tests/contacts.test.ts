// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/auth", () => ({ getToken: async () => "token", CONTACT_SCOPES: ["Contacts.ReadWrite"], ReconnectNeeded: class extends Error {} }));

import { Store } from "../src/store";
import { ContactSync, vcard } from "../src/contacts";
import type { Stop } from "../src/types";

const stop = (): Stop => ({ tripId: "t1", name: "Sugar Bowl Ski Area", kind: "", address: "624 Sugar Bowl Rd", city: "Truckee", phone: "", website: "", status: "follow", visitedOn: "2026-10-06", createdAt: "", updatedAt: "",
  contacts: [{ id: "c1", name: "Jamie Lee Ortiz", role: "Fleet Manager", phone: "(530) 555-0110", email: "jamie@example.com", notes: "", outlookStatus: "pending" }], notes: [] });

beforeEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });

describe("Outlook contacts", () => {
  it("creates the Outlook contact, then updates the same one on edit", async () => {
    const calls: { method: string; url: string; body: any }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
      calls.push({ method: init.method || "GET", url, body: init.body && JSON.parse(init.body) });
      return new Response(JSON.stringify({ id: "olk-1" }), { status: init.method === "POST" ? 201 : 200 });
    });
    const store = new Store();
    store.put("stops", "s1", stop());
    const sync = new ContactSync(store, () => "CA", () => true);
    sync.enabled = true;
    await sync.push("s1", "c1");
    const c = store.get("stops", "s1")!.contacts[0];
    expect(c).toMatchObject({ outlookId: "olk-1", outlookStatus: "ok" });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toMatchObject({ givenName: "Jamie Lee", surname: "Ortiz", companyName: "Sugar Bowl Ski Area", jobTitle: "Fleet Manager", mobilePhone: "(530) 555-0110",
      emailAddresses: [{ address: "jamie@example.com", name: "Jamie Lee Ortiz" }], businessAddress: { street: "624 Sugar Bowl Rd", city: "Truckee", state: "CA" } });

    store.put("stops", "s1", { ...store.get("stops", "s1")!, contacts: [{ ...c, phone: "(530) 555-0199" }] });
    await sync.push("s1", "c1");
    expect(calls[1]).toMatchObject({ method: "PATCH", url: expect.stringContaining("/me/contacts/olk-1") });
  });

  it("flags a missing permission instead of failing quietly", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { message: "Access is denied." } }), { status: 403 }));
    const store = new Store();
    store.put("stops", "s1", stop());
    const sync = new ContactSync(store, () => "CA", () => true);
    sync.enabled = true;
    await sync.push("s1", "c1");
    expect(sync.notPermitted).toBe(true);
    expect(store.get("stops", "s1")!.contacts[0].outlookStatus).toBe("error");
  });

  it("does nothing when turned off in Setup", async () => {
    const f = vi.fn(); vi.stubGlobal("fetch", f);
    const store = new Store();
    store.put("stops", "s1", stop());
    const sync = new ContactSync(store, () => "CA", () => false);
    sync.enabled = true;
    await sync.push("s1", "c1");
    expect(f).not.toHaveBeenCalled();
  });

  it("builds a vCard a phone can import", () => {
    const v = vcard(stop().contacts[0], stop(), "CA");
    expect(v).toContain("N:Ortiz;Jamie Lee;;;");
    expect(v).toContain("ORG:Sugar Bowl Ski Area");
    expect(v).toContain("TEL;TYPE=CELL:(530) 555-0110");
    expect(v).toContain("ADR;TYPE=WORK:;;624 Sugar Bowl Rd;Truckee;CA;;USA");
  });
});
