import { type ColName, type Collections, type Data, emptyData } from "./types";
import { merge, sameData } from "./merge";
import { graph, GraphError } from "./graph";

const LOCAL_KEY = "tripLog.data.v2";
const ETAG_KEY = "tripLog.etag.v2";
const DIRTY_KEY = "tripLog.dirty.v2";
// A plain file in the user's own OneDrive: Apps/SawtoothTripLog/trip-log.json
const ITEM = "/me/drive/root:/Apps/SawtoothTripLog/trip-log.json";
const FILE = ITEM + ":/content";

export type SyncState = "local" | "syncing" | "synced" | "offline" | "error";

function readLocal<T>(k: string, fallback: T): T {
  try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; }
}
function writeLocal(k: string, v: unknown) {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ }
}

/**
 * Holds all trips/stops/reminders. Every change is written to this device first,
 * then pushed to a JSON file in the user's OneDrive. Conflicting writes from
 * another device are merged record by record (see merge.ts).
 */
export class Store {
  data: Data = readLocal<Data>(LOCAL_KEY, emptyData());
  sync: SyncState = "local";
  lastError = "";
  lastErrorValue: unknown = null;
  private etag: string | null = readLocal<string | null>(ETAG_KEY, null);
  private dirty = readLocal<boolean>(DIRTY_KEY, false);
  private timer: number | undefined;
  private pushing = false;
  private remote = false;
  private listeners = new Set<() => void>();

  onChange(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit() { this.listeners.forEach((f) => f()); }

  get<C extends ColName>(col: C, id: string): Collections[C][string] | undefined {
    return this.data[col][id] as Collections[C][string] | undefined;
  }
  all<C extends ColName>(col: C): [string, Collections[C][string]][] {
    return Object.entries(this.data[col]) as [string, Collections[C][string]][];
  }

  put<C extends ColName>(col: C, id: string, rec: Collections[C][string], touch = true) {
    if (touch) rec.updatedAt = new Date().toISOString();
    (this.data[col] as Record<string, unknown>)[id] = rec;
    delete this.data.tombstones[col + "/" + id];
    this.changed();
  }

  remove(col: ColName, id: string) {
    delete (this.data[col] as Record<string, unknown>)[id];
    this.data.tombstones[col + "/" + id] = new Date().toISOString();
    this.changed();
  }

  /** Replace everything (used by import). */
  replaceAll(d: Data) { this.data = merge(this.data, d); this.changed(); }

  private changed() {
    writeLocal(LOCAL_KEY, this.data);
    this.dirty = true; writeLocal(DIRTY_KEY, true);
    this.emit();
    this.schedule();
  }

  private schedule(ms = 1200) {
    if (!this.remote) return;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.push(), ms);
  }

  /** Turn on OneDrive sync (after sign-in): pull, merge with this device, push if needed. */
  async connectRemote() {
    this.remote = true;
    window.addEventListener("online", () => void this.pull());
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void this.pull(); });
    await this.pull();
  }

  async pull() {
    if (!this.remote) return;
    if (!navigator.onLine) { this.setSync("offline"); return; }
    this.setSync("syncing");
    try {
      const r = await this.fetchRemote();
      if (r) {
        const merged = merge(this.data, r.data);
        const needPush = this.dirty || !sameData(merged, r.data);
        this.etag = r.etag; writeLocal(ETAG_KEY, r.etag);
        this.data = merged; writeLocal(LOCAL_KEY, merged);
        this.emit();
        if (needPush) { this.dirty = true; await this.push(); } else { this.setDirty(false); this.setSync("synced"); }
      } else {
        this.etag = null;
        await this.push();
      }
    } catch (e) { this.fail(e); }
  }

  async push(): Promise<void> {
    if (!this.remote || this.pushing) return;
    if (!navigator.onLine) { this.setSync("offline"); return; }
    this.pushing = true;
    this.setSync("syncing");
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const snapshot = JSON.stringify(this.data);
        try {
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (this.etag) headers["If-Match"] = this.etag;
          const r = await graph<{ eTag?: string }>(FILE, { method: "PUT", body: snapshot, raw: true, headers });
          this.etag = r.data?.eTag ?? r.etag; writeLocal(ETAG_KEY, this.etag);
          if (JSON.stringify(this.data) === snapshot) this.setDirty(false);
          this.setSync("synced");
          if (this.dirty) this.schedule(300);
          return;
        } catch (e) {
          if (e instanceof GraphError && (e.status === 412 || e.status === 409)) {
            const r = await this.fetchRemote();
            if (r) { this.data = merge(this.data, r.data); this.etag = r.etag; writeLocal(LOCAL_KEY, this.data); this.emit(); }
            else this.etag = null;
            continue;
          }
          throw e;
        }
      }
      throw new Error("Another device kept saving at the same time. Will retry.");
    } catch (e) { this.fail(e); this.schedule(15000); }
    finally { this.pushing = false; }
  }

  private async fetchRemote(): Promise<{ data: Data; etag: string | null } | null> {
    try {
      // Metadata first: its eTag is what If-Match on save is checked against.
      const meta = await graph<{ eTag: string; "@microsoft.graph.downloadUrl": string }>(ITEM);
      const res = await fetch(meta.data["@microsoft.graph.downloadUrl"]);
      if (!res.ok) throw new Error("Couldn't download your saved data (" + res.status + ")");
      const d = (await res.json()) as Partial<Data> | null;
      return { data: { ...emptyData(), ...(d && typeof d === "object" ? d : {}) }, etag: meta.data.eTag };
    } catch (e) {
      if (e instanceof GraphError && e.status === 404) return null;
      throw e;
    }
  }

  private setDirty(v: boolean) { this.dirty = v; writeLocal(DIRTY_KEY, v); }
  private setSync(s: SyncState) { if (this.sync !== s) { this.sync = s; this.emit(); } }
  private fail(e: unknown) {
    this.lastErrorValue = e;
    this.lastError = e instanceof Error ? e.message : String(e);
    this.setSync(navigator.onLine ? "error" : "offline");
  }
}
