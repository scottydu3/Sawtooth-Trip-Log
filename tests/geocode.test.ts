import { describe, it, expect, vi, afterEach } from "vitest";
import { locate } from "../src/geocode";
import type { Stop } from "../src/types";

const stop = (o: Partial<Stop>): Stop => ({ tripId: "t", name: "", kind: "", address: "", city: "", phone: "", website: "", status: "quoted", visitedOn: "", contacts: [], notes: [], createdAt: "", updatedAt: "", ...o });
const noWait = async () => {};

afterEach(() => vi.unstubAllGlobals());

function fakeNominatim(known: Record<string, [number, number]>) {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    const q = new URL(url).searchParams.get("q")!;
    asked.push(q);
    const hit = known[q];
    return new Response(JSON.stringify(hit ? [{ lat: String(hit[0]), lon: String(hit[1]) }] : []), { status: 200 });
  });
  return asked;
}

describe("address lookup", () => {
  it("finds a Nevada stop on a California trip by dropping the state", async () => {
    const asked = fakeNominatim({ "1094 Lakeshore Blvd, Incline Village": [39.24, -119.94] });
    const r = await locate(stop({ name: "Washoe County Public Works", address: "1094 Lakeshore Blvd", city: "Incline Village" }), "CA", noWait);
    expect(r).toEqual({ lat: 39.24, lng: -119.94, exact: true });
    expect(asked[0]).toBe("1094 Lakeshore Blvd, Incline Village, CA");
  });

  it("falls back to the business name, then the town", async () => {
    fakeNominatim({ "Auburn, CA": [38.9, -121.07] });
    const r = await locate(stop({ name: "Placer County Public Works", address: "3091 County Center Dr Ste 220", city: "Auburn" }), "CA", noWait);
    expect(r).toEqual({ lat: 38.9, lng: -121.07, exact: false });
  });

  it("reports a network problem so it can retry later", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 429 }));
    expect(await locate(stop({ city: "Truckee" }), "CA", noWait)).toBe("error");
  });
});
