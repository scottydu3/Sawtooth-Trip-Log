import type { Stop } from "./types";
import type { Store } from "./store";

/**
 * Finds map coordinates for stops that have an address but no location yet, using
 * OpenStreetMap's free geocoder (one request per second, per its usage policy).
 */
export class Geocoder {
  private queue: string[] = [];
  private running = false;
  private tried = new Set<string>();
  private notFound = new Set<string>();
  constructor(private store: Store, private stateOf: (s: Stop) => string) {}

  /** Queue every stop that could be placed on the map but isn't yet. */
  fillMissing() {
    for (const [id, s] of this.store.all("stops")) if (needsLookup(s) && !this.tried.has(id + query(s, this.stateOf(s)))) this.enqueue(id);
  }

  enqueue(id: string) {
    if (!this.queue.includes(id)) this.queue.push(id);
    void this.run();
  }

  get pending() { return this.queue.length; }

  /** True when the stop's current address was looked up and not found. */
  failed(id: string, s: Stop): boolean { return this.notFound.has(id + query(s, this.stateOf(s))); }

  private async run() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        if (!navigator.onLine) break;
        const id = this.queue.shift()!;
        const s = this.store.get("stops", id);
        if (!s || !needsLookup(s)) continue;
        const q = query(s, this.stateOf(s));
        const hit = await locate(s, this.stateOf(s));
        if (hit === "error") { await new Promise((r) => setTimeout(r, 1100)); continue; } // retried on next open or when back online
        this.tried.add(id + q);
        const cur = this.store.get("stops", id);
        if (!hit) this.notFound.add(id + q);
        // Only apply if nothing changed while we were looking it up.
        if (cur && query(cur, this.stateOf(cur)) === q && needsLookup(cur)) {
          if (hit) this.store.put("stops", id, { ...cur, lat: hit.lat, lng: hit.lng, geo: hit.exact ? "address" : "town", geoVersion: GEO_VERSION });
          else if (cur.lat != null) this.store.put("stops", id, { ...cur, geoVersion: GEO_VERSION }); // keep the old pin
        }
        await new Promise((r) => setTimeout(r, 1100));
      }
    } finally {
      this.running = false;
    }
  }
}

export function needsGeocode(s: Stop): boolean {
  return s.lat == null && !!(s.address || s.city);
}

/** Bumped when the lookup gets smarter, so pins found the old way are looked up once more. */
const GEO_VERSION = 2;

/** A stop with no pin yet, or an address pin from an older, less careful lookup. Hand-placed and GPS pins are never touched. */
function needsLookup(s: Stop): boolean {
  if (needsGeocode(s)) return true;
  return (s.geo === "address" || s.geo === "town") && (s.geoVersion || 1) < GEO_VERSION && !!(s.address || s.city);
}

function query(s: Stop, state: string): string {
  return [s.address, s.city, state].filter(Boolean).join(", ");
}

const pause = () => new Promise((r) => setTimeout(r, 1100));

/**
 * Try progressively looser searches: the full address, the address without the town (a rural
 * address whose mailing town isn't the town it's really in), the address without the state
 * (a Nevada stop on a California trip), the business name, then just the town.
 * Only a match on the building itself counts as exact. A match on just the street or the town
 * is kept as a fallback while the other searches get a chance to find the building.
 */
export async function locate(s: Stop, state: string, wait = pause): Promise<{ lat: number; lng: number; exact: boolean } | null | "error"> {
  const tries: [string[], "place" | "town"][] = [
    [[s.address, s.city, state], "place"],
    [[s.address, state], "place"],
    [[s.address, s.city], "place"],
    [[s.name, s.city, state], "place"],
    [[s.name, s.city], "place"],
    [[s.city, state], "town"],
    [[s.city], "town"],
  ];
  const seen = new Set<string>();
  let errored = false;
  let rough: { lat: number; lng: number; rank: number } | null = null;
  for (const [parts, kind] of tries) {
    if (!parts[0]) continue; // no street address / name / town for this try
    if (kind === "place" && !parts.slice(1).some(Boolean)) continue; // a street or name alone could be anywhere
    if (kind === "town" && rough) break; // already have something closer than the town center
    const q = parts.filter(Boolean).join(", ");
    if (seen.has(q)) continue;
    if (seen.size) await wait();
    seen.add(q);
    const hit = await lookup(q);
    if (hit === "error") errored = true;
    else if (hit && kind === "place" && hit.rank >= BUILDING) return { lat: hit.lat, lng: hit.lng, exact: true };
    else if (hit && (!rough || hit.rank > rough.rank)) rough = hit;
  }
  if (rough) return { lat: rough.lat, lng: rough.lng, exact: false };
  return errored ? "error" : null;
}

/** Nominatim's place_rank: 30 is a house, building or business; 26-27 a street; 16-20 a town. */
const BUILDING = 28;

/** null: nothing found; "error": couldn't ask (offline, rate-limited), so try again later. */
async function lookup(q: string): Promise<{ lat: number; lng: number; rank: number } | null | "error"> {
  try {
    const r = await fetch("https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&q=" + encodeURIComponent(q));
    if (!r.ok) return "error";
    const j = (await r.json()) as { lat: string; lon: string; place_rank?: number }[];
    if (!j.length) return null;
    return { lat: +(+j[0].lat).toFixed(6), lng: +(+j[0].lon).toFixed(6), rank: j[0].place_rank ?? 0 };
  } catch {
    return "error";
  }
}
