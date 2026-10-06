import { graph, GraphError } from "./graph";
import type { Store } from "./store";

/*
 * Pictures attached to stops (business cards, storefronts). Each one is shrunk on the
 * phone, kept in this device's IndexedDB so it shows offline, and uploaded to
 * OneDrive at Apps/SawtoothTripLog/photos/<id>.jpg. Other devices download it on demand.
 */

const FOLDER = "/me/drive/root:/Apps/SawtoothTripLog/photos/";
const DB_NAME = "tripLog.photos";
const MAX_SIDE = 2000; // keeps a business card legible at well under OneDrive's 4 MB simple-upload limit

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("blobs");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const r = fn(db.transaction("blobs", mode).objectStore("blobs"));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
const getBlob = (id: string) => idb<Blob | undefined>("readonly", (s) => s.get(id) as IDBRequest<Blob | undefined>).catch(() => undefined);
const putBlob = (id: string, b: Blob) => idb("readwrite", (s) => s.put(b, id)).catch(() => undefined);
const delBlob = (id: string) => idb("readwrite", (s) => s.delete(id)).catch(() => undefined);

/** Shrink a camera photo to a JPEG no larger than MAX_SIDE on its long edge. */
export async function shrink(file: Blob): Promise<Blob> {
  if (typeof createImageBitmap !== "function") return file;
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => null);
  if (!bmp) return file;
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob((b) => res(b || file), "image/jpeg", 0.85));
}

export class Photos {
  enabled = false; // OneDrive available (signed in)
  private urls = new Map<string, string>();
  private loading = new Set<string>();
  constructor(private store: Store, private onLoaded: () => void) {}

  /** Add a picture to a stop: saved on the device now, uploaded when possible. */
  async add(stopId: string, file: Blob) {
    const blob = await shrink(file);
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    await putBlob(id, blob);
    this.urls.set(id, URL.createObjectURL(blob));
    const s = this.store.get("stops", stopId);
    if (!s) return;
    this.store.put("stops", stopId, { ...s, photos: [...(s.photos || []), { id, at: new Date().toISOString() }] });
    void this.upload(stopId, id);
  }

  async remove(stopId: string, id: string) {
    const s = this.store.get("stops", stopId);
    if (s) this.store.put("stops", stopId, { ...s, photos: (s.photos || []).filter((p) => p.id !== id) });
    const u = this.urls.get(id);
    if (u) URL.revokeObjectURL(u);
    this.urls.delete(id);
    await delBlob(id);
    if (this.enabled) { try { await graph(FOLDER + id + ".jpg", { method: "DELETE" }); } catch { /* already gone */ } }
  }

  /** Object URL for a photo, or null while it's still loading (onLoaded fires when ready). */
  url(id: string): string | null {
    const u = this.urls.get(id);
    if (u) return u;
    void this.load(id);
    return null;
  }

  /** Upload anything taken offline or that failed earlier. */
  async uploadPending() {
    if (!this.enabled) return;
    for (const [sid, s] of this.store.all("stops")) for (const p of s.photos || []) if (!p.uploaded) await this.upload(sid, p.id);
  }

  private async upload(stopId: string, id: string) {
    if (!this.enabled || !navigator.onLine) return;
    const blob = await getBlob(id);
    if (!blob) return; // taken on another device that hasn't uploaded it yet
    try {
      await graph(FOLDER + id + ".jpg:/content", { method: "PUT", body: blob, raw: true, headers: { "Content-Type": "image/jpeg" } });
      const s = this.store.get("stops", stopId);
      if (s) this.store.put("stops", stopId, { ...s, photos: (s.photos || []).map((p) => (p.id === id ? { ...p, uploaded: true } : p)) });
    } catch { /* retried by uploadPending */ }
  }

  private async load(id: string) {
    if (this.loading.has(id)) return;
    this.loading.add(id);
    try {
      let blob = await getBlob(id);
      if (!blob && this.enabled && navigator.onLine) {
        const meta = await graph<{ "@microsoft.graph.downloadUrl": string }>(FOLDER + id + ".jpg");
        const r = await fetch(meta.data["@microsoft.graph.downloadUrl"]);
        if (r.ok) { blob = await r.blob(); await putBlob(id, blob); }
      }
      if (blob) { this.urls.set(id, URL.createObjectURL(blob)); this.onLoaded(); }
    } catch (e) {
      if (!(e instanceof GraphError && e.status === 404)) { /* network: try again next render */ }
    } finally {
      this.loading.delete(id);
    }
  }
}
