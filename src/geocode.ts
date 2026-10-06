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
    for (const [id, s] of this.store.all("stops")) if (needsGeocode(s) && !this.tried.has(id + query(s, this.stateOf(s)))) this.enqueue(id);
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
        if (!s || !needsGeocode(s)) continue;
        const q = query(s, this.stateOf(s));
        const hit = await locate(s, this.stateOf(s));
        if (hit === "error") { await new Promise((r) => setTimeout(r, 1100)); continue; } // retried on next open or when back online
        this.tried.add(id + q);
        const cur = this.store.get("stops", id);
        if (!hit) this.notFound.add(id + q);
        // Only apply if nothing changed while we were looking it up.
        if (hit && cur && query(cur, this.stateOf(cur)) === q && cur.lat == null) {
          this.store.put("stops", id, { ...cur, lat: hit.lat, lng: hit.lng, geo: hit.exact ? "address" : "town" });
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

function query(s: Stop, state: string): string {
  return [s.address, s.city, state].filter(Boolean).join(", ");
}

const pause = () => new Promise((r) => setTimeout(r, 1100));

/**
 * Try progressively looser searches: the full address, the address without the state
 * (a Nevada stop on a California trip), the business name in town, then just the town.
 */
export async function locate(s: Stop, state: string, wait = pause): Promise<{ lat: number; lng: number; exact: boolean } | null | "error"> {
  const tries: [string[], boolean][] = [
    [[s.address, s.city, state], true],
    [[s.address, s.city], true],
    [[s.name, s.city, state], true],
    [[s.name, s.city], true],
    [[s.city, state], false],
    [[s.city], false],
  ];
  const seen = new Set<string>();
  let errored = false;
  for (const [parts, exact] of tries) {
    if (exact && parts.length && !parts[0]) continue; // no street address / name for this try
    const q = parts.filter(Boolean).join(", ");
    if (!q || seen.has(q)) continue;
    if (seen.size) await wait();
    seen.add(q);
    const hit = await lookup(q);
    if (hit === "error") errored = true;
    else if (hit) return { ...hit, exact };
  }
  return errored ? "error" : null;
}

/** null: nothing found; "error": couldn't ask (offline, rate-limited), so try again later. */
async function lookup(q: string): Promise<{ lat: number; lng: number } | null | "error"> {
  try {
    const r = await fetch("https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&q=" + encodeURIComponent(q));
    if (!r.ok) return "error";
    const j = (await r.json()) as { lat: string; lon: string }[];
    if (!j.length) return null;
    return { lat: +(+j[0].lat).toFixed(6), lng: +(+j[0].lon).toFixed(6) };
  } catch {
    return "error";
  }
}
