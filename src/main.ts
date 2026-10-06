import "./styles.css";
import { registerSW } from "virtual:pwa-register";
import { authConfigured, currentAccount, initAuth, reconnect, ReconnectNeeded, signIn, signOut } from "./auth";
import { Store } from "./store";
import { CalendarSync } from "./calendar";
import type { Contact, Data, Reminder, Status, Stop, Trip } from "./types";
import { StopMap, CATEGORY, CATEGORY_COLOR, CATEGORY_LABEL, type Category } from "./map";
import { Geocoder, needsGeocode } from "./geocode";
import { Photos } from "./photos";

const STATES: [string, string][] = [["AL","Alabama"],["AK","Alaska"],["AZ","Arizona"],["AR","Arkansas"],["CA","California"],["CO","Colorado"],["CT","Connecticut"],["DE","Delaware"],["FL","Florida"],["GA","Georgia"],["HI","Hawaii"],["ID","Idaho"],["IL","Illinois"],["IN","Indiana"],["IA","Iowa"],["KS","Kansas"],["KY","Kentucky"],["LA","Louisiana"],["ME","Maine"],["MD","Maryland"],["MA","Massachusetts"],["MI","Michigan"],["MN","Minnesota"],["MS","Mississippi"],["MO","Missouri"],["MT","Montana"],["NE","Nebraska"],["NV","Nevada"],["NH","New Hampshire"],["NJ","New Jersey"],["NM","New Mexico"],["NY","New York"],["NC","North Carolina"],["ND","North Dakota"],["OH","Ohio"],["OK","Oklahoma"],["OR","Oregon"],["PA","Pennsylvania"],["RI","Rhode Island"],["SC","South Carolina"],["SD","South Dakota"],["TN","Tennessee"],["TX","Texas"],["UT","Utah"],["VT","Vermont"],["VA","Virginia"],["WA","Washington"],["WV","West Virginia"],["WI","Wisconsin"],["WY","Wyoming"]];
const STATE_NAME: Record<string, string> = Object.fromEntries(STATES);
const STATUSES: [Status, string][] = [["new","New lead"],["follow","Follow up"],["quoted","Quoted"],["customer","Customer"],["nofit","Not a fit"]];
const STATUS_NAME: Record<string, string> = Object.fromEntries(STATUSES);

type View = "trips" | "trip" | "stop" | "reminders" | "stops" | "settings" | "map";
interface Route { view: View; id?: string; from?: View }

const store = new Store();
const cal = new CalendarSync(store);
const geocoder = new Geocoder(store, (s) => store.get("trips", s.tripId)?.state || "");
const photos = new Photos(store, () => { if (route.view === "stop") render(); if (viewer) openViewer(viewer.stopId, viewer.id); });
let viewer: { stopId: string; id: string } | null = null;
const stopMap = new StopMap(document.getElementById("mapWrap")!, (id) => go({ view: "stop", id, from: "map" }));
let ready = false;
let needsSignIn = false;
let route: Route = { view: "trips" };
const backStack: Route[] = [];
const ui = { remFilter: "open", q: "", qStatus: "", sort: "date" as "date" | "name" };
let armed: string | null = null;

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const nowIso = () => new Date().toISOString();
function pref(k: string, v?: string): string | null {
  try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { /* blocked */ }
  return null;
}
const p2 = (n: number) => String(n).padStart(2, "0");
const today = () => { const d = new Date(); return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()); };
const fmtDay = (s?: string) => { if (!s) return ""; const d = new Date(s + "T12:00:00"); return isNaN(+d) ? s : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); };
const fmtWhen = (iso: string) => { const d = new Date(iso); return isNaN(+d) ? "" : d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); };
const toLocalInput = (d: Date) => d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()) + "T" + p2(d.getHours()) + ":" + p2(d.getMinutes());

function toast(msg: string) {
  const r = $("#toastRoot");
  r.innerHTML = '<div class="toast" role="status">' + esc(msg) + "</div>";
  clearTimeout((toast as unknown as { t: number }).t);
  (toast as unknown as { t: number }).t = window.setTimeout(() => (r.innerHTML = ""), 2600);
}

/* ---------- derived ---------- */
/** Newest visit first, or A to Z by business name, per the viewer's choice. */
const byChosenOrder = (a: [string, Stop], b: [string, Stop]) => {
  const byName = a[1].name.localeCompare(b[1].name, undefined, { sensitivity: "base", numeric: true });
  const byDate = (b[1].visitedOn || "").localeCompare(a[1].visitedOn || "") || (b[1].createdAt || "").localeCompare(a[1].createdAt || "");
  return ui.sort === "name" ? byName || byDate : byDate || byName;
};
const sortControl = () => '<div class="seg" role="group" aria-label="Sort stops">' +
  ([["date", "Date visited"], ["name", "A–Z"]] as const).map(([k, l]) => '<button data-act="sort" data-v="' + k + '" aria-pressed="' + (ui.sort === k) + '">' + l + "</button>").join("") + "</div>";
const stopsOf = (tid: string) => store.all("stops").filter(([, s]) => s.tripId === tid).sort(byChosenOrder);
const remsOf = (sid: string) => store.all("reminders").filter(([, r]) => r.stopId === sid).sort((a, b) => a[1].dueAt.localeCompare(b[1].dueAt));
const openRems = () => store.all("reminders").map(([, r]) => r).filter((r) => !r.done);
function dueClass(iso: string, done: boolean) { if (done) return ""; const t = +new Date(iso) - Date.now(); return t < 0 ? "over" : t < 48 * 3600e3 ? "soon" : ""; }
const tripLabel = (t?: Trip) => (t ? t.name || STATE_NAME[t.state] || "Trip" : "");
const mapsUrl = (s: Stop) => "https://www.google.com/maps/search/?api=1&query=" +
  encodeURIComponent(s.lat != null && s.lng != null && !s.address ? s.lat + "," + s.lng : [s.name, s.address, s.city].filter(Boolean).join(", "));

/* ---------- reminders + calendar ---------- */
function saveReminder(id: string, r: Reminder) {
  store.put("reminders", id, { ...r, calStatus: cal.enabled ? "pending" : r.calStatus });
  void cal.push(id);
}
function deleteReminder(id: string) {
  const r = store.get("reminders", id);
  if (r) void cal.remove(r.eventId);
  store.remove("reminders", id);
}

/* ---------- navigation ---------- */
function go(r: Route, push = true) { if (push) backStack.push(route); route = r; armed = null; window.scrollTo(0, 0); render(); }
function back() { route = backStack.pop() || { view: "trips" }; armed = null; render(); }
function tab(v: View) { backStack.length = 0; go({ view: v }, false); }

/* ---------- render ---------- */
const needsReconnect = () => store.sync === "error" && store.lastErrorValue instanceof ReconnectNeeded;

function syncBadge(): string {
  if (!authConfigured) return "On this device only";
  const label = { local: "Not synced", syncing: "Syncing…", synced: "Synced to OneDrive", offline: "Offline, will sync", error: "Sync problem" }[store.sync];
  return '<span class="sync ' + store.sync + '"><i></i>' + label + "</span>";
}

function render() {
  if (needsSignIn) { renderWelcome(); return; }
  $("#tabsNav").hidden = false;
  if (route.view === "trip" && !store.get("trips", route.id!)) route = { view: "trips" };
  if (route.view === "stop" && !store.get("stops", route.id!)) route = { view: "trips" };
  const v = route.view;
  let parts: [string, string];
  if (v === "trip") parts = viewTrip(route.id!);
  else if (v === "stop") parts = viewStop(route.id!);
  else if (v === "reminders") parts = viewReminders();
  else if (v === "stops") parts = viewAllStops();
  else if (v === "settings") parts = viewSettings();
  else if (v === "map") parts = viewMap();
  else parts = viewTrips();
  $("#hdr").innerHTML = parts[0];
  const active = document.activeElement as HTMLInputElement | null;
  const focusId = active?.id;
  const selPos = focusId ? active!.selectionStart : null;
  const draft = document.getElementById("noteText") as HTMLTextAreaElement | null;
  const draftVal = draft ? draft.value : "";
  $("#app").innerHTML = (needsReconnect() && v !== "map" ? '<div class="banner">Microsoft wants you to confirm your sign-in before the app can sync again. Your changes are safe on this phone. <div class="actions" style="margin-top:8px"><button class="btn primary sm" data-act="reconnect">Reconnect</button></div></div>' : "") + parts[1];
  const newDraft = document.getElementById("noteText") as HTMLTextAreaElement | null;
  if (draftVal && newDraft) newDraft.value = draftVal;
  if (focusId) {
    const el = document.getElementById(focusId) as HTMLInputElement | null;
    if (el && !el.closest(".sheet")) { el.focus(); try { el.setSelectionRange(selPos, selPos); } catch { /* not a text input */ } }
  }
  const overdue = openRems().filter((r) => new Date(r.dueAt).getTime() < Date.now()).length;
  if (v === "map") renderMap(); else stopMap.hide();
  const cur = ({ trips: "trips", trip: "trips", stop: route.from || "trips", reminders: "reminders", stops: "stops", settings: "settings", map: "map" } as Record<View, string>)[v];
  $("#tabs").innerHTML = ([["trips", "Trips"], ["map", "Map"], ["stops", "Stops"], ["reminders", "Reminders"], ["settings", "Setup"]] as const)
    .map(([k, l]) => '<button data-act="tab" data-v="' + k + '"' + (cur === k ? ' aria-current="page"' : "") + ">" + l + (k === "reminders" && overdue ? '<span class="badge">' + overdue + "</span>" : "") + "</button>").join("");
}

function headerHTML(title: string, sub: string, btn?: string, canBack = false) {
  return (canBack ? '<button class="back" data-act="back" aria-label="Back">&larr;</button>' : "") +
    '<div class="htitle"><h1>' + esc(title) + "</h1>" + (sub ? "<small>" + sub + "</small>" : "") + "</div>" + (btn || "");
}

const MS_LOGO = '<svg viewBox="0 0 21 21" aria-hidden="true"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg>';

function renderWelcome() {
  $("#hdr").innerHTML = headerHTML("Sawtooth Trip Log", "");
  $("#tabsNav").hidden = true;
  $("#app").innerHTML = '<div class="welcome"><h2>Every stop, every contact, every follow-up</h2>' +
    "<ul><li>Log trips by state and each business you visit</li><li>Keep contacts and notes on each stop</li><li>Reminders go straight onto your Outlook calendar</li><li>Saved in your OneDrive, on every device you sign in to</li></ul>" +
    '<button class="ms" data-act="signIn">' + MS_LOGO + "Sign in with Microsoft</button>" +
    '<p class="hint">Use your work Microsoft 365 account, the same one you use for Outlook.</p></div>';
}

function viewTrips(): [string, string] {
  const trips = store.all("trips").sort((a, b) => (b[1].startOn || "").localeCompare(a[1].startOn || ""));
  const hdr = headerHTML("Sawtooth Trip Log", syncBadge(), '<button class="hbtn" data-act="newTrip">+ Trip</button>');
  if (!ready) return [hdr, '<div class="empty">Loading your trips…</div>'];
  if (!trips.length) return [hdr, '<div class="empty"><strong>No trips yet</strong>Start a trip for the state you\'re working, then log each business you walk into as a stop. Contacts, notes and follow-ups live on each stop.<div class="actions"><button class="btn primary" data-act="newTrip">Start a trip</button></div></div>'];
  const groups: Record<string, [string, Trip][]> = {};
  trips.forEach(([id, t]) => { (groups[t.state] = groups[t.state] || []).push([id, t]); });
  let html = "";
  Object.keys(groups).sort((a, b) => (groups[b][0][1].startOn || "").localeCompare(groups[a][0][1].startOn || "")).forEach((st) => {
    html += '<div class="section-h"><h2>' + esc(STATE_NAME[st] || st) + '</h2></div><div class="list">';
    groups[st].forEach(([id, t]) => {
      const ss = stopsOf(id);
      const rs = openRems().filter((r) => r.tripId === id).length;
      const cust = ss.filter(([, s]) => s.status === "customer").length;
      html += '<button class="row" data-act="openTrip" data-id="' + id + '"><span class="shield">' + esc(t.state) + '</span><span class="grow"><div class="t">' + esc(tripLabel(t)) + '</div><div class="s">' +
        esc([fmtDay(t.startOn), t.endOn ? fmtDay(t.endOn) : ""].filter(Boolean).join(" – ")) + (rs ? " · " + rs + " open reminder" + (rs > 1 ? "s" : "") : "") +
        '</div></span><span class="count"><b>' + ss.length + "</b>stops" + (cust ? "<br>" + cust + " cust." : "") + "</span></button>";
    });
    html += "</div>";
  });
  return [hdr, html];
}

function stopRow(id: string, s: Stop, showTrip: boolean) {
  const t = store.get("trips", s.tripId);
  const c = (s.contacts || [])[0];
  return '<button class="row" data-act="openStop" data-id="' + id + '"><span class="grow"><div class="t">' + esc(s.name) + '</div><div class="s">' +
    esc([s.city || s.address, c && c.name, showTrip && t ? t.state : ""].filter(Boolean).join(" · ")) +
    '</div></span><span style="display:flex;flex-direction:column;align-items:flex-end;gap:4px"><span class="pill st-' + esc(s.status) + '">' + esc(STATUS_NAME[s.status] || "") +
    '</span><span class="due">' + esc(fmtDay(s.visitedOn)) + "</span></span></button>";
}

function viewTrip(id: string): [string, string] {
  const t = store.get("trips", id)!;
  const ss = stopsOf(id);
  const hdr = headerHTML(tripLabel(t), esc((STATE_NAME[t.state] || t.state) + " · " + [fmtDay(t.startOn), fmtDay(t.endOn)].filter(Boolean).join(" – ")), '<button class="hbtn" data-act="newStop" data-id="' + id + '">+ Stop</button>', true);
  const tally = STATUSES.map(([k, l]) => { const n = ss.filter(([, s]) => s.status === k).length; return n ? '<span class="pill st-' + k + '">' + n + " " + esc(l) + "</span>" : ""; }).join(" ");
  let html = tally ? '<div style="display:flex;flex-wrap:wrap;gap:6px">' + tally + "</div>" : "";
  html += '<div class="section-h"><h2>Stops</h2><button data-act="newStop" data-id="' + id + '">+ Add stop</button></div>' + (ss.length > 1 ? sortControl() : "");
  html += ss.length ? '<div class="list">' + ss.map(([sid, s]) => stopRow(sid, s, false)).join("") + "</div>" : '<div class="empty"><strong>No stops yet</strong>Add each business you visit on this trip.</div>';
  const k = "trip:" + id;
  html += '<div class="actions" style="margin-top:22px"><button class="btn" data-act="editTrip" data-id="' + id + '">Edit trip</button><button class="btn danger' + (armed === k ? " arm" : "") + '" data-act="delTrip" data-id="' + id + '">' + (armed === k ? "Tap again to delete trip and its " + ss.length + " stops" : "Delete trip") + "</button></div>";
  return [hdr, html];
}

function viewStop(id: string): [string, string] {
  const s = store.get("stops", id)!;
  const t = store.get("trips", s.tripId);
  const hdr = headerHTML(s.name, t ? esc(t.state + " · " + tripLabel(t)) : "", '<button class="hbtn" data-act="editStop" data-id="' + id + '">Edit</button>', true);
  let html = '<div class="card"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:10px"><span class="pill st-' + esc(s.status) + '">' + esc(STATUS_NAME[s.status] || "") + '</span><span class="due">Visited ' + esc(fmtDay(s.visitedOn) || "—") + '</span></div><dl class="kv">' +
    (s.kind ? "<dt>Type</dt><dd>" + esc(s.kind) + "</dd>" : "") +
    (s.address || s.city ? "<dt>Address</dt><dd>" + esc([s.address, s.city].filter(Boolean).join(", ")) + "</dd>" : "") +
    (s.phone ? '<dt>Main</dt><dd><a href="tel:' + esc(s.phone.replace(/[^\d+]/g, "")) + '" style="color:inherit">' + esc(s.phone) + "</a></dd>" : "") +
    (s.website ? "<dt>Web</dt><dd>" + esc(s.website) + "</dd>" : "") +
    '</dl><div class="actions">' + '<a class="btn sm" href="' + esc(mapsUrl(s)) + '" target="_blank" rel="noopener">Open in Maps</a>' +
    STATUSES.filter(([k]) => k !== s.status).slice(0, 3).map(([k, l]) => '<button class="btn sm" data-act="setStatus" data-id="' + id + '" data-v="' + k + '">Mark ' + esc(l.toLowerCase()) + "</button>").join("") + "</div></div>";

  html += '<div class="section-h"><h2>Contacts</h2><button data-act="newContact" data-id="' + id + '">+ Add contact</button></div>';
  const cs = s.contacts || [];
  html += cs.length ? '<div class="list">' + cs.map((c) => '<div class="card contact"><div style="display:flex;justify-content:space-between;gap:8px"><div><div class="name">' + esc(c.name || "Unnamed") + "</div>" + (c.role ? '<div style="color:var(--muted);font-size:13px">' + esc(c.role) + "</div>" : "") + '</div><button class="btn sm" data-act="editContact" data-id="' + id + '" data-c="' + esc(c.id) + '">Edit</button></div>' +
    (c.phone ? '<div class="line">' + esc(c.phone) + ' <a class="btn sm" href="tel:' + esc(c.phone.replace(/[^\d+]/g, "")) + '">Call</a><a class="btn sm" href="sms:' + esc(c.phone.replace(/[^\d+]/g, "")) + '">Text</a></div>' : "") +
    (c.email ? '<div class="line">' + esc(c.email) + ' <a class="btn sm" href="mailto:' + esc(c.email) + '">Email</a><button class="btn sm" data-act="copy" data-v="' + esc(c.email) + '">Copy</button></div>' : "") +
    (c.notes ? '<div style="font-size:14px;color:var(--muted)">' + esc(c.notes) + "</div>" : "") + "</div>").join("") + "</div>" : '<div class="empty">No contacts yet. Add the buyer, owner or manager you spoke with.</div>';

  const ps = s.photos || [];
  html += '<div class="section-h"><h2>Photos</h2><label for="photoInput" class="addlink">+ Add photo</label></div><input id="photoInput" type="file" accept="image/*" multiple data-id="' + id + '" hidden>';
  html += ps.length ? '<div class="photos">' + ps.map((p) => { const u = photos.url(p.id); return '<button class="thumb" data-act="viewPhoto" data-id="' + id + '" data-p="' + esc(p.id) + '" aria-label="View photo">' + (u ? '<img src="' + esc(u) + '" alt="">' : '<span class="hint">' + (navigator.onLine ? "Loading…" : "Offline") + "</span>") + "</button>"; }).join("") + "</div>"
    : '<div class="empty">Snap a business card, a storefront or a price sheet so it stays with this stop.</div>';

  html += '<div class="section-h"><h2>Reminders</h2><button data-act="newRem" data-id="' + id + '">+ Add reminder</button></div>';
  const rs = remsOf(id);
  html += rs.length ? '<div class="list">' + rs.map(([rid, r]) => remRow(rid, r, false)).join("") + "</div>" : '<div class="empty">No reminders. Add a follow-up call, a quote deadline or a return visit' + (cal.enabled ? " and it goes on your Outlook calendar." : ".") + "</div>";

  html += '<div class="section-h"><h2>Notes</h2></div><div class="card quicknote"><label for="noteText" class="hint" style="margin:0">New note</label><textarea id="noteText" placeholder="What did you learn? Needs, current supplier, volume, objections, next step…"></textarea><div><button class="btn primary" data-act="addNote" data-id="' + id + '">Save note</button></div></div>';
  const ns = (s.notes || []).slice().sort((a, b) => b.at.localeCompare(a.at));
  if (ns.length) html += '<div class="list" style="margin-top:12px;gap:14px">' + ns.map((n) => '<div class="note"><time>' + esc(fmtWhen(n.at)) + ' <button class="btn sm" style="margin-left:6px;padding:1px 7px" data-act="delNote" data-id="' + id + '" data-n="' + esc(n.id) + '">' + (armed === "note:" + n.id ? "Tap to confirm" : "Delete") + "</button></time><p>" + esc(n.text) + "</p></div>").join("") + "</div>";
  const k = "stop:" + id;
  html += '<div class="actions" style="margin-top:26px"><button class="btn danger' + (armed === k ? " arm" : "") + '" data-act="delStop" data-id="' + id + '">' + (armed === k ? "Tap again to delete this stop" : "Delete stop") + "</button></div>";
  return [hdr, html];
}

function calChip(id: string, r: Reminder): string {
  if (!cal.enabled) return "";
  if (r.calStatus === "ok") return '<span class="cal ok">On Outlook ✓</span>';
  if (r.calStatus === "error") return '<button class="btn sm" data-act="calRetry" data-id="' + id + '">Retry Outlook</button>';
  if (r.calStatus === "removed") return '<button class="btn sm" data-act="calRetry" data-id="' + id + '">Deleted in Outlook · Re-add</button>';
  return '<span class="cal pending">Adding to Outlook…</span>';
}

function remRow(rid: string, r: Reminder, showStop: boolean) {
  const s = store.get("stops", r.stopId);
  return '<div class="row' + (r.done ? " done" : "") + '" style="cursor:default"><button class="check' + (r.done ? " on" : "") + '" data-act="toggleRem" data-id="' + rid + '" aria-label="' + (r.done ? "Mark not done" : "Mark done") + '">' + (r.done ? "&#10003;" : "") +
    '</button><span class="grow"><div class="t">' + esc(r.title) + '</div><div class="due ' + dueClass(r.dueAt, r.done) + '">' + esc(fmtWhen(r.dueAt)) + "</div>" +
    (showStop && s ? '<div class="s"><a href="#" data-act="openStop" data-id="' + esc(r.stopId) + '" style="color:inherit">' + esc(s.name) + "</a></div>" : "") +
    '</span><span style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">' + calChip(rid, r) + '<button class="btn sm" data-act="editRem" data-id="' + rid + '">Edit</button></span></div>';
}

function viewReminders(): [string, string] {
  const hdr = headerHTML("Reminders", openRems().length + " open");
  const all = store.all("reminders").sort((a, b) => a[1].dueAt.localeCompare(b[1].dueAt));
  const f = ui.remFilter;
  const list = all.filter(([, r]) => (f === "open" ? !r.done : f === "done" ? r.done : true));
  if (f === "done") list.reverse();
  let html = '<div class="seg">' + [["open", "Open"], ["done", "Done"], ["all", "All"]].map(([k, l]) => '<button data-act="remFilter" data-v="' + k + '" aria-pressed="' + (f === k) + '">' + l + "</button>").join("") + "</div>";
  html += list.length ? '<div class="list">' + list.map(([id, r]) => remRow(id, r, true)).join("") + "</div>" : '<div class="empty"><strong>Nothing here</strong>Reminders are added from a stop, so each one is tied to the business and contacts it\'s about.</div>';
  if (cal.enabled) html += '<p class="hint">Each reminder is an event on your Outlook calendar, with a 15-minute alert. Move or rename it in Outlook and the change shows up here.</p>';
  return [hdr, html];
}

function viewAllStops(): [string, string] {
  const hdr = headerHTML("All stops", store.all("stops").length + " total", '<button class="hbtn" data-act="export">CSV</button>');
  const q = ui.q.trim().toLowerCase();
  const list = store.all("stops").filter(([, s]) => {
    if (ui.qStatus && s.status !== ui.qStatus) return false;
    if (!q) return true;
    const t = store.get("trips", s.tripId);
    const hay = [s.name, s.kind, s.address, s.city, s.phone, t?.state, t && STATE_NAME[t.state], ...(s.contacts || []).flatMap((c) => [c.name, c.role, c.email, c.phone]), ...(s.notes || []).map((n) => n.text)].join(" ").toLowerCase();
    return hay.includes(q);
  }).sort(byChosenOrder);
  let html = '<div class="filters"><input id="q" type="search" placeholder="Search names, contacts, notes, towns" value="' + esc(ui.q) + '" aria-label="Search stops"><select id="qStatus" aria-label="Filter by status"><option value="">Any status</option>' +
    STATUSES.map(([k, l]) => '<option value="' + k + '"' + (ui.qStatus === k ? " selected" : "") + ">" + l + "</option>").join("") + "</select></div>" + sortControl();
  html += list.length ? '<div class="list">' + list.map(([id, s]) => stopRow(id, s, true)).join("") + "</div>" : '<div class="empty">' + (store.all("stops").length ? "No stops match." : "No stops yet. Start a trip, then add stops to it.") + "</div>";
  return [hdr, html];
}

function mapStops(): [string, Stop][] {
  return store.all("stops"); // always every stop from every trip
}
function viewMap(): [string, string] {
  const n = store.all("stops").filter(([, s]) => s.lat != null).length;
  return [headerHTML("Map", n + " stops on the map", '<button class="hbtn" data-act="mapFit">Show all</button>'), ""];
}
function renderMap() {
  geocoder.fillMissing();
  const inState = mapStops();
  const shown = inState;
  const counts: Record<Category, number> = { customer: 0, potential: 0, lead: 0, nofit: 0 };
  inState.forEach(([, s]) => { if (s.lat != null) counts[CATEGORY[s.status]]++; });
  const missing = inState.filter(([, s]) => s.lat == null);
  const noAddr = missing.filter(([, s]) => !needsGeocode(s)).length;
  const notFound = missing.filter(([id, s]) => needsGeocode(s) && geocoder.failed(id, s)).length;
  const locating = missing.length - noAddr - notFound;
  $("#mapPanel").innerHTML = '<div class="maplegend">' + (["customer", "potential", "lead", "nofit"] as Category[]).map((c) =>
    '<span class="chip"><span class="dot" style="background:' + CATEGORY_COLOR[c] + '"></span>' + CATEGORY_LABEL[c] + " <b>" + counts[c] + "</b></span>").join("") +
    "</div>" +
    (locating ? '<div class="mapnote">Finding ' + locating + " address" + (locating > 1 ? "es" : "") + " on the map…</div>" : "") +
    (notFound ? '<div class="mapnote">' + notFound + " address" + (notFound > 1 ? "es" : "") + " couldn't be found. Check the address on " + (notFound > 1 ? "those stops" : "that stop") + ', or use "Use my location" when you\'re there.</div>' : "") +
    (noAddr ? '<div class="mapnote">' + noAddr + " stop" + (noAddr > 1 ? "s have" : " has") + " no address, so " + (noAddr > 1 ? "they're" : "it's") + " not on the map.</div>" : "") +
    (!store.all("stops").length ? '<div class="mapnote">Your stops will show up here as colored dots once you add them.</div>' : "");
  stopMap.show(shown, (s) => [s.city, store.get("trips", s.tripId)?.state].filter(Boolean).join(", "));
}

function viewSettings(): [string, string] {
  const hdr = headerHTML("Setup", "");
  const acct = currentAccount();
  let html = '<div class="section-h"><h2>Account</h2></div><div class="card">';
  if (acct) html += '<p style="margin:0">Signed in as <strong>' + esc(acct.name || acct.username) + "</strong><br><span class=\"hint\">" + esc(acct.username) + '</span></p><div class="actions"><button class="btn" data-act="signOut">Sign out</button></div>';
  else html += '<p style="margin:0">Running on this device only. Your data isn\'t backed up or synced and reminders don\'t go to Outlook.</p>';
  html += "</div>";
  html += '<div class="section-h"><h2>Sync</h2></div><div class="card"><p style="margin:0">' + syncBadge() + "</p>" +
    (store.sync === "error" ? '<p class="hint">' + esc(store.lastError) + "</p>" : "") +
    (acct ? '<p class="hint">Saved in your OneDrive at Apps › SawtoothTripLog › trip-log.json. Reminders are events on your Outlook calendar.</p><div class="actions"><button class="btn" data-act="syncNow">Sync now</button></div>' : "") + "</div>";
  html += '<div class="section-h"><h2>Export and backup</h2></div><div class="card"><p style="margin:0">Download every stop as a spreadsheet, or a full backup you can import later.</p><div class="actions"><button class="btn" data-act="export">Spreadsheet (CSV)</button><button class="btn" data-act="backup">Backup file</button><label class="btn" for="importFile">Import backup</label><input id="importFile" type="file" accept=".json,application/json" hidden></div></div>';
  html += '<div class="section-h"><h2>Install on your phone</h2></div><div class="card"><p style="margin:0"><strong>iPhone:</strong> open this page in Safari, tap Share, then Add to Home Screen.<br><strong>Android:</strong> open it in Chrome, tap the menu, then Install app.</p></div>';
  return [hdr, html];
}

/* ---------- sheets ---------- */
function sheet(title: string, fields: string, onSubmit: (v: Record<string, string>) => boolean | void, extra = "") {
  $("#sheetRoot").innerHTML = '<div class="sheet-bg" data-act="closeSheetBg"><div class="sheet" role="dialog" aria-modal="true" aria-label="' + esc(title) + '"><h3>' + esc(title) + '</h3><form id="sheetForm">' + fields + '<div class="foot">' + extra + '<button type="button" class="btn" data-act="closeSheet">Cancel</button><button type="submit" class="btn primary">Save</button></div></form></div></div>';
  const f = $<HTMLFormElement>("#sheetForm");
  f.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = Object.fromEntries([...new FormData(f).entries()].map(([k, x]) => [k, String(x)]));
    if (onSubmit(v) !== false) closeSheet();
  });
  const first = f.querySelector<HTMLElement>("input,select,textarea");
  if (first) setTimeout(() => first.focus(), 30);
}
function closeSheet() { $("#sheetRoot").innerHTML = ""; }
const fld = (label: string, name: string, val: unknown, type = "text", attrs = "") => "<label>" + esc(label) + '<input id="f_' + name + '" name="' + name + '" type="' + type + '" value="' + esc(val) + '" ' + attrs + "></label>";
const area = (label: string, name: string, val: unknown) => "<label>" + esc(label) + '<textarea id="f_' + name + '" name="' + name + '">' + esc(val) + "</textarea></label>";
const sel = (label: string, name: string, opts: [string, string][], val: unknown) => "<label>" + esc(label) + '<select id="f_' + name + '" name="' + name + '">' + opts.map(([k, l]) => '<option value="' + esc(k) + '"' + (k === val ? " selected" : "") + ">" + esc(l) + "</option>").join("") + "</select></label>";

function tripSheet(id?: string) {
  const t: Partial<Trip> = id ? store.get("trips", id)! : { state: pref("lastState") || "ID", startOn: today() };
  sheet(id ? "Edit trip" : "New trip", sel("State", "state", STATES, t.state) + fld("Trip name (optional)", "name", t.name, "text", 'placeholder="e.g. Treasure Valley swing"') + '<div class="two">' + fld("Start", "startOn", t.startOn, "date") + fld("End", "endOn", t.endOn, "date") + "</div>", (v) => {
    pref("lastState", v.state);
    const nid = id || uid();
    store.put("trips", nid, { ...(t as Trip), createdAt: t.createdAt || nowIso(), state: v.state, name: v.name.trim(), startOn: v.startOn, endOn: v.endOn });
    if (!id) go({ view: "trip", id: nid });
  });
}

let pendingGeo: { lat: number; lng: number } | null = null;
function stopSheet(tripId: string | null, id?: string) {
  const s: Partial<Stop> = id ? store.get("stops", id)! : { tripId: tripId!, status: "new", visitedOn: today() };
  pendingGeo = null;
  const tripOpts = store.all("trips").map(([k, t]) => [k, t.state + " · " + tripLabel(t)] as [string, string]);
  const geo = "geolocation" in navigator ? '<div class="geo"><button type="button" class="btn sm" data-act="useLocation">Use my location</button><span class="hint" id="geoMsg" style="margin:0"></span></div>' : "";
  sheet(id ? "Edit stop" : "New stop", fld("Business name", "name", s.name, "text", "required") + fld("Type of business", "kind", s.kind, "text", 'placeholder="e.g. Hardware store, contractor"') + geo + fld("Address", "address", s.address) + '<div class="two">' + fld("Town", "city", s.city) + fld("Visited", "visitedOn", s.visitedOn, "date") + "</div>" + '<div class="two">' + sel("Status", "status", STATUSES, s.status) + fld("Website", "website", s.website) + "</div>" +
    // Phone numbers belong to contacts; an older stop's main number stays editable here.
    (s.phone ? fld("Main phone", "phone", s.phone, "tel") : "") + (id ? sel("Trip", "tripId", tripOpts, s.tripId) : "") + (id ? "" : newStopExtras()), (v) => {
    if (!v.name.trim()) return false;
    const nid = id || uid();
    const doc: Stop = {
      ...(s as Stop), contacts: s.contacts || [], notes: s.notes || [], createdAt: s.createdAt || nowIso(),
      tripId: v.tripId || s.tripId!, name: v.name.trim(), kind: v.kind.trim(), address: v.address.trim(), city: v.city.trim(),
      visitedOn: v.visitedOn, phone: (v.phone ?? "").trim(), status: v.status as Status, website: v.website.trim(),
      ...(pendingGeo ? { ...pendingGeo, geo: "gps" as const } : {}),
    };
    if (!pendingGeo && id && s.geo !== "gps" && (s.address !== doc.address || s.city !== doc.city)) {
      delete doc.lat; delete doc.lng; delete doc.geo; // address changed: find it again
    }
    const newPhotos = id ? [] : [...(document.getElementById("f_photos") as HTMLInputElement | null)?.files || []];
    if (!id) {
      if (v.note && v.note.trim()) doc.notes = [{ id: uid(), text: v.note.trim(), at: nowIso() }];
      doc.contacts = contactsFromForm(v);
    }
    store.put("stops", nid, doc);
    if (!id && v.remOn && v.remDue) {
      const due = new Date(v.remDue);
      if (!isNaN(+due)) {
        const who = doc.contacts[0]?.name || doc.name;
        saveReminder(uid(), { stopId: nid, tripId: doc.tripId, title: v.remTitle.trim() || "Follow up with " + who, dueAt: due.toISOString(), durationMin: +v.remLen || 30, details: v.remDetails.trim(), done: false, createdAt: nowIso(), updatedAt: nowIso(), createdBy: deviceId() });
      }
    }
    if (newPhotos.length) void (async () => { for (const f of newPhotos) await photos.add(nid, f); })();
    if (needsGeocode(doc)) geocoder.enqueue(nid);
    if (id && (s.name !== doc.name || s.address !== doc.address)) remsOf(nid).forEach(([rid, r]) => { if (!r.done && r.eventId) void cal.push(rid); });
    if (!id) go({ view: "stop", id: nid });
  });
}

/* The rest of the New stop form, so a visit can be logged in one go. */
const contactRow = (i: number) => '<div class="contactrow" data-row="' + i + '">' +
  '<div class="two">' + fld("Contact name", "c_name_" + i, "") + fld("Title / role", "c_role_" + i, "", "text", 'placeholder="e.g. Owner"') + "</div>" +
  '<div class="two">' + fld("Phone", "c_phone_" + i, "", "tel") + fld("Email", "c_email_" + i, "", "email") + "</div></div>";

function newStopExtras(): string {
  const d = new Date(); d.setDate(d.getDate() + 3); d.setHours(9, 0, 0, 0);
  return '<div class="formsec">Contact</div><div id="contactRows">' + contactRow(0) + '</div><button type="button" class="btn sm" data-act="addContactRow" style="align-self:flex-start">+ Another contact</button>' +
    '<div class="formsec">Note</div>' + area("What did you learn?", "note", "") +
    '<div class="formsec">Reminder</div><label class="checkline"><input type="checkbox" id="f_remOn" name="remOn" value="1"> Add a follow-up reminder' + (cal.enabled ? " to Outlook" : "") + "</label>" +
    '<div id="remFields" hidden>' + fld("What", "remTitle", "", "text", 'placeholder="Follow up with…"') + '<div class="two">' + fld("When", "remDue", toLocalInput(d), "datetime-local") +
    sel("Length", "remLen", [["15", "15 min"], ["30", "30 min"], ["60", "1 hour"], ["120", "2 hours"]], "30") + "</div>" + area("Details", "remDetails", "") + "</div>" +
    '<div class="formsec">Photos</div><label>Business card, storefront, price sheet<input id="f_photos" type="file" accept="image/*" multiple></label>';
}

function contactsFromForm(v: Record<string, string>): Contact[] {
  const rows = Object.keys(v).filter((k) => k.startsWith("c_name_")).map((k) => k.slice(7));
  return rows.map((i) => ({ id: uid(), name: (v["c_name_" + i] || "").trim(), role: (v["c_role_" + i] || "").trim(), phone: (v["c_phone_" + i] || "").trim(), email: (v["c_email_" + i] || "").trim(), notes: "" }))
    .filter((c) => c.name || c.phone || c.email);
}

function useLocation() {
  const msg = document.getElementById("geoMsg");
  if (msg) msg.textContent = "Finding you…";
  navigator.geolocation.getCurrentPosition(async (pos) => {
    pendingGeo = { lat: +pos.coords.latitude.toFixed(6), lng: +pos.coords.longitude.toFixed(6) };
    if (msg) msg.textContent = "Location saved";
    try {
      // OpenStreetMap's free reverse geocoder, to fill the address fields.
      const r = await fetch("https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=" + pendingGeo.lat + "&lon=" + pendingGeo.lng);
      const j = await r.json();
      const a = j.address || {};
      const addr = document.getElementById("f_address") as HTMLInputElement | null;
      const city = document.getElementById("f_city") as HTMLInputElement | null;
      const street = [a.house_number, a.road].filter(Boolean).join(" ");
      if (addr && !addr.value && street) addr.value = street;
      if (city && !city.value) city.value = a.city || a.town || a.village || a.hamlet || "";
      if (msg) msg.textContent = "Address filled in. Check it before saving.";
    } catch { /* coordinates are still saved */ }
  }, () => { if (msg) msg.textContent = "Couldn't get your location. Check location permission for this app."; }, { enableHighAccuracy: true, timeout: 15000 });
}

function contactSheet(stopId: string, cid?: string) {
  const s = store.get("stops", stopId)!;
  const cs = (s.contacts || []).slice();
  const c: Partial<Contact> = cid ? cs.find((x) => x.id === cid)! : {};
  const delBtn = cid ? '<button type="button" class="btn danger" data-act="delContact" data-id="' + stopId + '" data-c="' + esc(cid) + '" style="margin-right:auto">Delete</button>' : "";
  sheet(cid ? "Edit contact" : "New contact", fld("Name", "name", c.name, "text", "required") + fld("Title / role", "role", c.role, "text", 'placeholder="e.g. Owner, purchasing manager"') + fld("Phone", "phone", c.phone, "tel") + fld("Email", "email", c.email, "email") + area("About this person", "notes", c.notes), (v) => {
    const nc: Contact = { id: cid || uid(), name: v.name.trim(), role: v.role.trim(), phone: v.phone.trim(), email: v.email.trim(), notes: v.notes.trim() };
    const next = cid ? cs.map((x) => (x.id === cid ? nc : x)) : [...cs, nc];
    store.put("stops", stopId, { ...s, contacts: next });
  }, delBtn);
}

function remSheet(stopId: string | null, rid?: string) {
  const r = rid ? store.get("reminders", rid)! : null;
  const sid = stopId || r!.stopId;
  const s = store.get("stops", sid);
  const d = r ? new Date(r.dueAt) : (() => { const x = new Date(); x.setDate(x.getDate() + 3); x.setHours(9, 0, 0, 0); return x; })();
  const delBtn = rid ? '<button type="button" class="btn danger" data-act="delRem" data-id="' + rid + '" style="margin-right:auto">Delete</button>' : "";
  const defTitle = "Follow up with " + ((s?.contacts || [])[0]?.name || s?.name || "");
  sheet(rid ? "Edit reminder" : "New reminder", fld("What", "title", r ? r.title : defTitle, "text", "required") + '<div class="two">' + fld("When", "dueAt", toLocalInput(d), "datetime-local", "required") + sel("Length", "durationMin", [["15", "15 min"], ["30", "30 min"], ["60", "1 hour"], ["120", "2 hours"]], String(r ? r.durationMin : 30)) + "</div>" + area("Details", "details", r?.details), (v) => {
    const due = new Date(v.dueAt);
    if (isNaN(+due)) return false;
    const nid = rid || uid();
    const doc: Reminder = { ...(r || { createdAt: nowIso(), done: false } as Reminder), stopId: sid, tripId: s ? s.tripId : r!.tripId, title: v.title.trim(), dueAt: due.toISOString(), durationMin: +v.durationMin, details: v.details.trim(), createdBy: r?.createdBy || deviceId() };
    saveReminder(nid, doc);
    if (!rid) toast(cal.enabled ? "Reminder saved and sent to Outlook" : "Reminder saved");
  }, delBtn);
}

function deviceId(): string {
  let id = pref("tripLog.device");
  if (!id) { id = uid(); pref("tripLog.device", id); }
  return id;
}

/* ---------- photo viewer ---------- */
function openViewer(stopId: string, id: string) {
  viewer = { stopId, id };
  const u = photos.url(id);
  const p = (store.get("stops", stopId)?.photos || []).find((x) => x.id === id);
  $("#sheetRoot").innerHTML = '<div class="viewer" data-act="closeViewerBg"><div class="viewer-img">' + (u ? '<img src="' + esc(u) + '" alt="Photo">' : '<span class="hint">Loading…</span>') + '</div><div class="viewer-bar"><span class="hint">' + esc(p ? fmtWhen(p.at) : "") + (p && !p.uploaded && cal.enabled ? " · not uploaded yet" : "") + '</span><button class="btn danger sm" data-act="delPhoto" data-id="' + stopId + '" data-p="' + esc(id) + '">' + (armed === "photo:" + id ? "Tap again to delete" : "Delete") + '</button><button class="btn sm" data-act="closeViewer">Close</button></div></div>';
}
function closeViewer() { viewer = null; armed = null; closeSheet(); }

/* ---------- export / import ---------- */
function download(filename: string, text: string, type: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function exportCsv() {
  const q = (v: unknown) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
  const rows: unknown[][] = [["State", "Trip", "Business", "Type", "Status", "Visited", "Address", "Town", "Main phone", "Website", "Contacts", "Notes"]];
  store.all("stops").forEach(([, s]) => {
    const t = store.get("trips", s.tripId);
    rows.push([t?.state, tripLabel(t), s.name, s.kind, STATUS_NAME[s.status], s.visitedOn, s.address, s.city, s.phone, s.website,
      (s.contacts || []).map((c) => [c.name, c.role, c.phone, c.email].filter(Boolean).join(" / ")).join("; "),
      (s.notes || []).map((n) => n.at.slice(0, 10) + ": " + n.text).join(" | ")]);
  });
  download("sales-stops-" + today() + ".csv", rows.map((r) => r.map(q).join(",")).join("\r\n"), "text/csv");
}
function importBackup(file: File) {
  file.text().then((txt) => {
    const j = JSON.parse(txt) as Partial<Data>;
    if (!j || typeof j !== "object" || !j.trips || !j.stops) throw new Error("bad file");
    store.replaceAll({ schema: 1, trips: j.trips, stops: j.stops, reminders: j.reminders || {}, tombstones: j.tombstones || {} });
    toast("Imported " + Object.keys(j.stops).length + " stops");
    if (cal.enabled) void cal.pullAll();
  }).catch(() => toast("That file isn't a Trip Log backup."));
}

/* ---------- events ---------- */
document.addEventListener("click", async (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
  if (!el) return;
  const a = el.dataset.act!;
  const id = el.dataset.id!;
  if (el.tagName === "A" && a !== "openStop") return;
  if (a === "openStop" && el.tagName === "A") e.preventDefault();
  switch (a) {
    case "tab": tab(el.dataset.v as View); break;
    case "back": back(); break;
    case "signIn": try { await signIn(); } catch (err) { toast(err instanceof Error ? err.message : "Sign-in failed"); } break;
    case "signOut": await signOut(); break;
    case "reconnect": await reconnect(); break;
    case "syncNow": void store.pull().then(() => cal.pullAll()); break;
    case "newTrip": tripSheet(); break;
    case "editTrip": tripSheet(id); break;
    case "openTrip": go({ view: "trip", id }); break;
    case "openStop": go({ view: "stop", id, from: route.view === "stops" || route.view === "reminders" || route.view === "map" ? route.view : "trips" }); break;
    case "newStop": stopSheet(id); break;
    case "editStop": stopSheet(null, id); break;
    case "useLocation": useLocation(); break;
    case "addContactRow": {
      const box = document.getElementById("contactRows")!;
      const n = box.querySelectorAll(".contactrow").length;
      box.insertAdjacentHTML("beforeend", contactRow(n));
      (document.getElementById("f_c_name_" + n) as HTMLInputElement).focus();
      break;
    }
    case "setStatus": { const s = store.get("stops", id)!; store.put("stops", id, { ...s, status: el.dataset.v as Status }); toast("Marked " + STATUS_NAME[el.dataset.v!].toLowerCase()); break; }
    case "newContact": contactSheet(id); break;
    case "editContact": contactSheet(id, el.dataset.c); break;
    case "delContact": { const s = store.get("stops", id)!; store.put("stops", id, { ...s, contacts: (s.contacts || []).filter((c) => c.id !== el.dataset.c) }); closeSheet(); break; }
    case "addNote": {
      const ta = $<HTMLTextAreaElement>("#noteText");
      const txt = ta.value.trim();
      if (!txt) { ta.focus(); break; }
      const s = store.get("stops", id)!;
      ta.value = "";
      store.put("stops", id, { ...s, notes: [...(s.notes || []), { id: uid(), text: txt, at: nowIso() }] });
      toast("Note saved");
      break;
    }
    case "delNote": {
      const k = "note:" + el.dataset.n;
      if (armed !== k) { armed = k; render(); break; }
      armed = null;
      const s = store.get("stops", id)!;
      store.put("stops", id, { ...s, notes: (s.notes || []).filter((n) => n.id !== el.dataset.n) });
      break;
    }
    case "newRem": remSheet(id); break;
    case "editRem": remSheet(null, id); break;
    case "delRem": deleteReminder(id); closeSheet(); break;
    case "toggleRem": { const r = store.get("reminders", id)!; store.put("reminders", id, { ...r, done: !r.done }); break; }
    case "calRetry": { const r = store.get("reminders", id)!; saveReminder(id, { ...r, eventId: r.calStatus === "removed" ? undefined : r.eventId }); break; }
    case "mapFit": stopMap.fitAll(mapStops()); break;
    case "sort": ui.sort = el.dataset.v === "name" ? "name" : "date"; pref("tripLog.sort", ui.sort); render(); break;
    case "remFilter": ui.remFilter = el.dataset.v!; render(); break;
    case "export": exportCsv(); break;
    case "backup": download("trip-log-backup-" + today() + ".json", JSON.stringify(store.data, null, 1), "application/json"); break;
    case "copy": { const v = el.dataset.v!; try { await navigator.clipboard.writeText(v); toast("Copied"); } catch { toast(v); } break; }
    case "delStop": {
      const k = "stop:" + id;
      if (armed !== k) { armed = k; render(); break; }
      armed = null;
      remsOf(id).forEach(([rid]) => deleteReminder(rid));
      (store.get("stops", id)?.photos || []).forEach((p) => void photos.remove(id, p.id));
      store.remove("stops", id);
      back();
      break;
    }
    case "delTrip": {
      const k = "trip:" + id;
      if (armed !== k) { armed = k; render(); break; }
      armed = null;
      stopsOf(id).forEach(([sid]) => { remsOf(sid).forEach(([rid]) => deleteReminder(rid)); store.remove("stops", sid); });
      store.remove("trips", id);
      back();
      break;
    }
    case "viewPhoto": openViewer(id, el.dataset.p!); break;
    case "closeViewer": closeViewer(); break;
    case "closeViewerBg": if (e.target === el || (e.target as HTMLElement).classList.contains("viewer-img")) closeViewer(); break;
    case "delPhoto": {
      const k = "photo:" + el.dataset.p;
      if (armed !== k) { armed = k; openViewer(id, el.dataset.p!); break; }
      const pid = el.dataset.p!;
      closeViewer();
      void photos.remove(id, pid);
      toast("Photo deleted");
      break;
    }
    case "closeSheet": closeSheet(); break;
    case "closeSheetBg": if (e.target === el) closeSheet(); break;
  }
});
document.addEventListener("input", (e) => {
  const t = e.target as HTMLInputElement;
  if (t.id === "q") { ui.q = t.value; render(); }
  if (t.id === "qStatus") { ui.qStatus = t.value; render(); }
});
document.addEventListener("change", (e) => {
  const t = e.target as HTMLInputElement;
  if (t.id === "f_remOn") { document.getElementById("remFields")!.hidden = !t.checked; if (t.checked) document.getElementById("f_remTitle")?.focus(); }
  if (t.id === "importFile" && t.files?.[0]) importBackup(t.files[0]);
  if (t.id === "photoInput" && t.files?.length) {
    const sid = t.dataset.id!;
    const files = [...t.files];
    toast(files.length > 1 ? "Adding " + files.length + " photos…" : "Adding photo…");
    void (async () => { for (const f of files) await photos.add(sid, f); toast(cal.enabled ? "Photo saved" : "Photo saved on this device"); })().catch(() => toast("Couldn't read that picture."));
  }
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("#sheetRoot").innerHTML) { if (viewer) closeViewer(); else closeSheet(); } });

let renderQueued = false;
store.onChange(() => {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const tag = document.activeElement?.tagName;
    if ($("#sheetRoot").innerHTML && tag !== "BODY") return; // don't redraw under an open form
    render();
  });
});
setInterval(() => { const tag = document.activeElement?.tagName; if (!$("#sheetRoot").innerHTML && tag !== "TEXTAREA" && tag !== "INPUT") render(); }, 60000);

/* ---------- boot ---------- */
async function boot() {
  if (pref("tripLog.sort") === "name") ui.sort = "name";
  render();
  let account = null;
  try { account = await initAuth(); } catch (e) { toast("Sign-in error: " + (e instanceof Error ? e.message : String(e))); }
  ready = true;
  if (authConfigured && !account) { needsSignIn = true; render(); return; }
  render();
  if (account) {
    cal.enabled = true;
    cal.deviceId = deviceId();
    photos.enabled = true;
    await store.connectRemote();
    // Renewal needed right at startup: pass through Microsoft's page now, before any typing starts.
    if (needsReconnect()) { try { if (!sessionStorage.getItem("tripLog.reconnectTried")) { sessionStorage.setItem("tripLog.reconnectTried", "1"); await reconnect(); return; } } catch { /* storage blocked */ } }
    geocoder.fillMissing();
    void photos.uploadPending();
    await cal.pullAll();
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void cal.pullAll(); });
    // Back in signal with the app open: send reminders made offline and place new addresses.
    window.addEventListener("online", () => { void cal.pullAll(); geocoder.fillMissing(); void photos.uploadPending(); });
  }
}
void boot();
registerSW({ immediate: true });
