import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { Status, Stop } from "./types";

export type Category = "customer" | "potential" | "follow" | "lead" | "nofit" | "competitor" | "dealer" | "demo";

export const CATEGORY: Record<Status, Category> = {
  customer: "customer",
  new: "lead",
  follow: "follow",
  quoted: "potential",
  nofit: "nofit",
  competitor: "competitor",
  dealer: "dealer",
  demo: "demo",
};
export const CATEGORY_LABEL: Record<Category, string> = {
  customer: "Customer",
  potential: "Quoted/Follow up",
  follow: "Prospect/Stay In Touch",
  lead: "New lead",
  nofit: "Not a fit",
  competitor: "Competitor",
  dealer: "Dealer",
  demo: "Demo",
};
export const CATEGORY_COLOR: Record<Category, string> = {
  customer: "#23a455",
  potential: "#f28c18",
  follow: "#f2c500",
  lead: "#1f6fe0",
  nofit: "#d8402f",
  competitor: "#111111",
  dealer: "#e8559a",
  demo: "#ffffff",
};
/** Outline around a pin; white pins get a dark one so they show on the map. */
export const CATEGORY_OUTLINE = (c: Category) => (c === "demo" ? "#111111" : "#ffffff");

/** The full-screen map of every stop, one colored dot per stop. */
export class StopMap {
  private map: L.Map | null = null;
  private layer = L.layerGroup();
  private fitted = false;
  private lastKey = "";

  private moving: string | null = null;
  private names = new Map<string, string>();

  // Live "you are here" position, watched only while the map is showing.
  private watchId: number | null = null;
  private here: L.LatLng | null = null;
  private meDot: L.Marker | null = null;
  private meRing: L.Circle | null = null;
  private zoomToMe = false;

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
      this.addLocateButton();
    }
    this.map.invalidateSize();
    this.watchMe();
    const key = JSON.stringify(stops.map(([id, s]) => [id, s.lat, s.lng, s.status, s.name]));
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.layer.clearLayers();
    this.names = new Map(stops.map(([id, s]) => [id, s.name]));
    const pts: L.LatLngExpression[] = [];
    // Draw "not interested" first and customers last so the dots that matter most sit on top.
    const order: Category[] = ["competitor", "nofit", "lead", "follow", "potential", "demo", "dealer", "customer"];
    const sorted = stops.slice().sort((a, b) => order.indexOf(CATEGORY[a[1].status]) - order.indexOf(CATEGORY[b[1].status]));
    for (const [id, s] of sorted) {
      if (s.lat == null || s.lng == null) continue;
      const cat = CATEGORY[s.status] || "potential";
      const m = L.circleMarker([s.lat, s.lng], {
        radius: 9, color: CATEGORY_OUTLINE(cat), weight: 2, fillColor: CATEGORY_COLOR[cat], fillOpacity: 1,
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

  hide() { this.endMove(); this.stopWatching(); this.host.hidden = true; }

  /** The locate-me button: zoom to where you are now. */
  locateMe() {
    if (!this.map) return;
    if (this.here) { this.map.setView(this.here, Math.max(this.map.getZoom(), 16)); return; }
    this.zoomToMe = true;
    this.host.querySelector(".locbtn")?.classList.add("busy");
    this.watchMe();
  }

  private addLocateButton() {
    const Locate = L.Control.extend({
      onAdd: () => {
        const b = L.DomUtil.create("button", "locbtn");
        b.type = "button";
        b.title = "Show where I am";
        b.setAttribute("aria-label", "Show where I am");
        b.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3"/></svg>';
        L.DomEvent.disableClickPropagation(b);
        L.DomEvent.on(b, "click", () => this.locateMe());
        return b;
      },
    });
    new Locate({ position: "bottomright" }).addTo(this.map!);
  }

  private watchMe() {
    if (this.watchId != null || !("geolocation" in navigator)) {
      if (this.zoomToMe && !("geolocation" in navigator)) this.locateFailed("This device can't share its location.");
      return;
    }
    this.watchId = navigator.geolocation.watchPosition(
      (p) => this.moveMe(p.coords.latitude, p.coords.longitude, p.coords.accuracy),
      (err) => {
        // Only speak up when the button was pressed; otherwise the map just works without the dot.
        if (err.code === err.PERMISSION_DENIED) {
          this.stopWatching();
          if (this.zoomToMe) this.locateFailed("Location is off for this app. On iPhone: Settings › Privacy & Security › Location Services › Safari Websites › While Using the App. Then try again.");
        } else if (this.zoomToMe && !this.here) this.locateFailed("Couldn't find your location yet. Try again in a moment, ideally with a clear view of the sky.");
      },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 },
    );
  }

  private stopWatching() {
    if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }

  private moveMe(lat: number, lng: number, accuracy: number) {
    if (!this.map) return;
    this.here = L.latLng(lat, lng);
    if (!this.meDot) {
      this.meRing = L.circle(this.here, { radius: accuracy, color: "#1a73e8", weight: 1, opacity: 0.4, fillColor: "#1a73e8", fillOpacity: 0.12, interactive: false }).addTo(this.map);
      this.meDot = L.marker(this.here, {
        icon: L.divIcon({ className: "medot", html: "<span></span>", iconSize: [22, 22], iconAnchor: [11, 11] }),
        interactive: false, keyboard: false, zIndexOffset: 1000,
      }).addTo(this.map);
    } else {
      this.meDot.setLatLng(this.here);
      this.meRing!.setLatLng(this.here).setRadius(accuracy);
    }
    if (this.zoomToMe) {
      this.zoomToMe = false;
      this.host.querySelector(".locbtn")?.classList.remove("busy");
      this.map.setView(this.here, Math.max(this.map.getZoom(), 16));
    }
  }

  private locateFailed(msg: string) {
    this.zoomToMe = false;
    this.host.querySelector(".locbtn")?.classList.remove("busy");
    let n = this.host.querySelector<HTMLElement>(".loctoast");
    if (!n) { n = document.createElement("div"); n.className = "loctoast"; this.host.appendChild(n); }
    n.textContent = msg;
    clearTimeout((n as any)._t);
    (n as any)._t = setTimeout(() => n!.remove(), 8000);
  }

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
