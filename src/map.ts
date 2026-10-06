import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { Status, Stop } from "./types";

export type Category = "customer" | "potential" | "nofit";

export const CATEGORY: Record<Status, Category> = {
  customer: "customer",
  new: "potential",
  follow: "potential",
  quoted: "potential",
  nofit: "nofit",
};
export const CATEGORY_LABEL: Record<Category, string> = {
  customer: "Customer",
  potential: "Potential",
  nofit: "Not interested",
};
export const CATEGORY_COLOR: Record<Category, string> = {
  customer: "#23a455",
  potential: "#f2b705",
  nofit: "#d8402f",
};

/** The full-screen map of every stop, one colored dot per stop. */
export class StopMap {
  private map: L.Map | null = null;
  private layer = L.layerGroup();
  private fitted = false;
  private lastKey = "";

  constructor(private host: HTMLElement, private onOpen: (id: string) => void) {}

  show(stops: [string, Stop][], label: (s: Stop) => string) {
    this.host.hidden = false;
    this.place();
    if (!this.map) {
      this.map = L.map(this.host.querySelector<HTMLElement>("#map")!, { zoomControl: true, attributionControl: true })
        .setView([39.5, -98.35], 4);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(this.map);
      this.layer.addTo(this.map);
      this.host.addEventListener("click", (e) => {
        const b = (e.target as HTMLElement).closest<HTMLElement>("[data-open-stop]");
        if (b) this.onOpen(b.dataset.openStop!);
      });
      window.addEventListener("resize", () => this.place());
    }
    this.map.invalidateSize();
    const key = JSON.stringify(stops.map(([id, s]) => [id, s.lat, s.lng, s.status, s.name]));
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.layer.clearLayers();
    const pts: L.LatLngExpression[] = [];
    // Draw "not interested" first and customers last so the dots that matter most sit on top.
    const order: Category[] = ["nofit", "potential", "customer"];
    const sorted = stops.slice().sort((a, b) => order.indexOf(CATEGORY[a[1].status]) - order.indexOf(CATEGORY[b[1].status]));
    for (const [id, s] of sorted) {
      if (s.lat == null || s.lng == null) continue;
      const cat = CATEGORY[s.status] || "potential";
      const m = L.circleMarker([s.lat, s.lng], {
        radius: 9, color: "#ffffff", weight: 2, fillColor: CATEGORY_COLOR[cat], fillOpacity: 1,
      });
      m.bindPopup(popupHTML(id, s, label(s)), { closeButton: false, offset: [0, -4] });
      m.addTo(this.layer);
      pts.push([s.lat, s.lng]);
    }
    if (!this.fitted && pts.length) { this.fit(pts); this.fitted = true; }
  }

  fitAll(stops: [string, Stop][]) {
    const pts = stops.filter(([, s]) => s.lat != null && s.lng != null).map(([, s]) => [s.lat!, s.lng!] as L.LatLngExpression);
    if (pts.length) this.fit(pts);
  }

  hide() { this.host.hidden = true; }

  private fit(pts: L.LatLngExpression[]) {
    if (!this.map) return;
    if (pts.length === 1) this.map.setView(pts[0], 13);
    else this.map.fitBounds(L.latLngBounds(pts), { padding: [36, 36], maxZoom: 14 });
  }

  /** Fill the space between the header and the tab bar. */
  private place() {
    const top = document.querySelector("header.top")!.getBoundingClientRect().bottom;
    const tabs = document.querySelector("nav.tabs")!.getBoundingClientRect().height;
    this.host.style.top = top + "px";
    this.host.style.bottom = tabs + "px";
    this.map?.invalidateSize();
  }
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function popupHTML(id: string, s: Stop, sub: string) {
  const cat = CATEGORY[s.status];
  const contact = (s.contacts || [])[0];
  return '<div class="pop"><div class="pop-t">' + esc(s.name) + '</div><div class="pop-s"><span class="dot" style="background:' + CATEGORY_COLOR[cat] + '"></span>' + esc(CATEGORY_LABEL[cat]) + (sub ? " · " + esc(sub) : "") + "</div>" +
    (contact ? '<div class="pop-s">' + esc([contact.name, contact.role].filter(Boolean).join(", ")) + "</div>" : "") +
    (s.geo === "town" ? '<div class="pop-s">Pin is the town center. Add a street address for an exact spot.</div>' : "") +
    '<button class="btn sm primary" data-open-stop="' + esc(id) + '">Open stop</button></div>';
}
