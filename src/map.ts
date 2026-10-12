import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { Status, Stop } from "./types";

export type Category = "customer" | "potential" | "follow" | "lead" | "nofit" | "competitor" | "dealer";

export const CATEGORY: Record<Status, Category> = {
  customer: "customer",
  new: "lead",
  follow: "follow",
  quoted: "potential",
  nofit: "nofit",
  competitor: "competitor",
  dealer: "dealer",
};
export const CATEGORY_LABEL: Record<Category, string> = {
  customer: "Customer",
  potential: "Quoted",
  follow: "Follow up",
  lead: "New lead",
  nofit: "Not a fit",
  competitor: "Competitor",
  dealer: "Dealer",
};
export const CATEGORY_COLOR: Record<Category, string> = {
  customer: "#23a455",
  potential: "#f28c18",
  follow: "#f2c500",
  lead: "#1f6fe0",
  nofit: "#d8402f",
  competitor: "#111111",
  dealer: "#e8559a",
};

/** The full-screen map of every stop, one colored dot per stop. */
export class StopMap {
  private map: L.Map | null = null;
  private layer = L.layerGroup();
  private fitted = false;
  private lastKey = "";

  private moving: string | null = null;
  private names = new Map<string, string>();

  constructor(private host: HTMLElement, private onOpen: (id: string) => void, private onMove: (id: string, lat: number, lng: number) => void) {}

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
        const mv = (e.target as HTMLElement).closest<HTMLElement>("[data-move-pin]");
        if (mv) this.startMove(mv.dataset.movePin!);
        if ((e.target as HTMLElement).closest("[data-move-cancel]")) this.endMove();
      });
      // While moving a pin, the next tap on the map is where the stop really is.
      this.map.on("click", (e: L.LeafletMouseEvent) => {
        if (!this.moving) return;
        const id = this.moving;
        this.endMove();
        this.onMove(id, e.latlng.lat, e.latlng.lng);
      });
      window.addEventListener("resize", () => this.place());
    }
    this.map.invalidateSize();
    const key = JSON.stringify(stops.map(([id, s]) => [id, s.lat, s.lng, s.status, s.name]));
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.layer.clearLayers();
    this.names = new Map(stops.map(([id, s]) => [id, s.name]));
    const pts: L.LatLngExpression[] = [];
    // Draw "not interested" first and customers last so the dots that matter most sit on top.
    const order: Category[] = ["competitor", "nofit", "lead", "follow", "potential", "dealer", "customer"];
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

  hide() { this.endMove(); this.host.hidden = true; }

  private startMove(id: string) {
    this.map?.closePopup();
    this.moving = id;
    this.host.classList.add("moving");
    let bar = this.host.querySelector<HTMLElement>(".movebar");
    if (!bar) { bar = document.createElement("div"); bar.className = "movebar"; this.host.appendChild(bar); }
    bar.innerHTML = "<span>Zoom in and tap the map where <b>" + esc(this.names.get(id) || "this stop") + '</b> really is.</span><button class="btn sm" data-move-cancel>Cancel</button>';
  }

  private endMove() {
    this.moving = null;
    this.host.classList.remove("moving");
    this.host.querySelector(".movebar")?.remove();
  }

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
    (s.geo === "town" ? '<div class="pop-s">This pin is approximate. Tap Move pin to put it in the right spot.</div>' : "") +
    '<div class="pop-b"><button class="btn sm primary" data-open-stop="' + esc(id) + '">Open stop</button><button class="btn sm" data-move-pin="' + esc(id) + '">Move pin</button></div></div>';
}
