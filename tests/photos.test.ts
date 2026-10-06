// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, it, expect, vi } from "vitest";

vi.mock("../src/auth", () => ({ getToken: async () => "token" }));

import { Store } from "../src/store";
import { Photos } from "../src/photos";

describe("stop photos", () => {
  it("keeps the picture on the device, uploads it to OneDrive and marks it uploaded", async () => {
    const puts: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
      if ((init.method || "GET") === "PUT") { puts.push(url); return new Response(JSON.stringify({ id: "x" }), { status: 201 }); }
      if (init.method === "DELETE") { puts.push("DELETE " + url); return new Response(null, { status: 204 }); }
      return new Response("{}", { status: 404 });
    });
    URL.createObjectURL = () => "blob:test";
    URL.revokeObjectURL = () => {};
    const store = new Store();
    store.put("stops", "s1", { tripId: "t", name: "B&G Excavation", kind: "", address: "", city: "Tahoe Vista", phone: "", website: "", status: "new", visitedOn: "", contacts: [], notes: [], createdAt: "", updatedAt: "" });
    const photos = new Photos(store, () => {});
    photos.enabled = true;
    await photos.add("s1", new Blob(["fake-jpeg"], { type: "image/jpeg" }));
    await new Promise((r) => setTimeout(r, 50));
    const p = store.get("stops", "s1")!.photos!;
    expect(p).toHaveLength(1);
    expect(p[0].uploaded).toBe(true);
    expect(puts[0]).toContain("/me/drive/root:/Apps/SawtoothTripLog/photos/" + p[0].id + ".jpg:/content");
    expect(photos.url(p[0].id)).toBe("blob:test");

    await photos.remove("s1", p[0].id);
    expect(store.get("stops", "s1")!.photos).toHaveLength(0);
    expect(puts[1]).toContain("DELETE");
  });
});
