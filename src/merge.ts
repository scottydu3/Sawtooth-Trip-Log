import { type ColName, type Data, emptyData } from "./types";

const COLS: ColName[] = ["trips", "stops", "reminders"];

/** Record-level merge: the newer updatedAt wins; a tombstone newer than a record deletes it. */
export function merge(a: Data, b: Data): Data {
  const out = emptyData();
  for (const [k, t] of [...Object.entries(a.tombstones), ...Object.entries(b.tombstones)]) {
    if (!out.tombstones[k] || out.tombstones[k] < t) out.tombstones[k] = t;
  }
  for (const col of COLS) {
    const ids = new Set([...Object.keys(a[col]), ...Object.keys(b[col])]);
    for (const id of ids) {
      const x = (a[col] as Record<string, { updatedAt: string }>)[id];
      const y = (b[col] as Record<string, { updatedAt: string }>)[id];
      const win = !x ? y : !y ? x : (y.updatedAt > x.updatedAt ? y : x);
      const dead = out.tombstones[col + "/" + id];
      if (dead && dead >= win.updatedAt) continue;
      (out[col] as Record<string, unknown>)[id] = win;
    }
  }
  return out;
}

export function sameData(a: Data, b: Data): boolean {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

function normalize(d: Data) {
  const sort = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).sort(([x], [y]) => x.localeCompare(y)));
  return { trips: sort(d.trips), stops: sort(d.stops), reminders: sort(d.reminders), tombstones: sort(d.tombstones) };
}
