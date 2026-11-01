// Billboard panel: pick a board, upload its creative, align it on Street View, save the layout.
// The viewer (index.html) is read-only and picks up saved changes via the "billboardsUpdated" storage key.
import * as M from "./sv-math.js";

const cfg = window.APP_CONFIG || {};
const $ = (s) => document.querySelector(s);
const UPDATED_KEY = "billboardsUpdated";

let boards = []; // GeoJSON point features
let current = null; // selected feature
let panorama = null;
let panoMeta = { dist: 0, heading: 0, when: "" };
const align = { active: false, corners: null };

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function setStatus(msg, kind = "ok") {
  const el = $("#status");
  el.textContent = msg; el.hidden = !msg;
  el.classList.toggle("error", kind === "error"); el.classList.toggle("ok", kind === "ok");
  if (kind === "error") console.error(msg); else console.info(msg);
}
const bumpUpdated = () => { try { localStorage.setItem(UPDATED_KEY, String(Date.now())); } catch {} };
const props = () => current?.properties || {};
const geom = () => (current ? M.geomFromFeature(current) : null);

// ---------- Billboards ----------
async function loadBoards() {
  const r = await fetch("/api/billboards");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const geo = await r.json();
  boards = geo.features.filter((f) => f.geometry?.type === "Point" && f.properties?.id);
  $("#bb-count").textContent = `(${boards.length})`;
  renderBoardList();
}

// Two modes: catalog (all billboards, full width) and product view (one billboard: data, editor, Street View).
function showCatalog() {
  if (align.active) setAligning(false);
  document.body.classList.add("catalog");
  history.replaceState(null, "", location.pathname);
  renderBoardList();
}
function openBoard(id) {
  document.body.classList.remove("catalog");
  return selectBoard(id);
}
function fmtVal(v) {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "object") return `<pre>${esc(JSON.stringify(v, null, 2))}</pre>`;
  return esc(String(v));
}
function renderFullData() {
  if (!current) return;
  const p = current.properties;
  $("#bb-detail-title").textContent = p.name || p.id;
  const rows = [...Object.entries(p), ["geometry", current.geometry]];
  $("#bb-full").innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${fmtVal(v)}</dd>`).join("");
}
function boardStatus(p) {
  const aligned = Object.values(p.sv_alignments || {}).some((a) => a && (Array.isArray(a) || a.corners));
  return { creative: !!p.creative_url, aligned };
}
function renderBoardList() {
  const q = ($("#bb-filter").value || "").trim().toLowerCase();
  const shown = boards.filter((f) => {
    if (!q) return true;
    const p = f.properties;
    return [p.id, p.name, p.owner, p.type].some((v) => String(v ?? "").toLowerCase().includes(q));
  });
  const here = current?.properties.id;
  const list = $("#bb-list");
  list.innerHTML = shown.map((f) => {
    const p = f.properties, s = boardStatus(p);
    const thumb = s.creative
      ? `<img src="${esc(p.creative_url)}" alt="" loading="lazy">`
      : `<span class="bb-noimg">No creative</span>`;
    return `<li role="option" tabindex="0" aria-selected="${p.id === here}" class="${p.id === here ? "here" : ""}" data-id="${esc(p.id)}" title="${esc(p.name || p.id)}">
      <span class="bb-thumb">${thumb}</span>
      <span class="bb-id">${esc(p.id)}</span>
      <span class="bb-name">${esc(p.name || p.owner || "")}</span>
      <span class="bb-badges">
        <span class="badge ${s.creative ? "on" : ""}" title="${s.creative ? "Creative uploaded" : "No creative"}">Creative</span>
        <span class="badge ${s.aligned ? "on" : ""}" title="${s.aligned ? "Aligned on Street View" : "Not aligned"}">Aligned</span>
      </span>
    </li>`;
  }).join("");
  $("#bb-empty").hidden = shown.length > 0;
  renderFullData(); // keeps the product view in step with saves and uploads
}
$("#bb-filter").addEventListener("input", renderBoardList);
$("#bb-back").addEventListener("click", showCatalog);
$("#bb-list").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-id]"); if (li) openBoard(li.dataset.id);
});
$("#bb-list").addEventListener("keydown", (e) => {
  const li = e.target.closest("li[data-id]"); if (!li || (e.key !== "Enter" && e.key !== " ")) return;
  e.preventDefault(); openBoard(li.dataset.id);
});
async function selectBoard(id) {
  current = boards.find((f) => f.properties.id === id) || null;
  if (!current) return;
  renderBoardList(); // move the highlight to the selected board
  history.replaceState(null, "", `?id=${encodeURIComponent(id)}`);
  $("#to-viewer").href = `/?id=${encodeURIComponent(id)}`;
  if (align.active) setAligning(false);
  renderCreative(); renderGeom(); renderSavedList();
  await openStreetView();
}
function renderGeom() {
  const p = props(), g = geom();
  const rows = [
    ["Position", g ? `${g.lat.toFixed(6)}, ${g.lng.toFixed(6)}` : "—"],
    ["Base", `${g?.base ?? "?"} m`], ["Board", `${g?.bw ?? "?"} × ${g?.bh ?? "?"} m`], ["Facing", `${Math.round(g?.heading ?? 0)}°`],
    ["Source", p.geometry_source || "surveyed / manual"],
  ];
  $("#geom").innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
  $("#creative-ratio").textContent = g ? `${g.bw}:${g.bh}` : "?";
}

// ---------- Creative ----------
function renderCreative() {
  const url = props().creative_url || null;
  const img = $("#creative-preview");
  img.hidden = !url; $("#creative-empty").hidden = !!url;
  if (url) img.src = url;
  $("#creative-clear").disabled = !url;
  const board = $("#sv-board");
  board.classList.toggle("has-creative", !!url);
  board.style.backgroundImage = url ? `url("${url}")` : "";
  renderBoardList(); // keep the Creative badge in the list current
}
$("#creative-file").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file || !current) return;
  const id = props().id;
  setStatus(`Uploading creative for ${id}…`);
  try {
    const r = await fetch(`/api/billboards/${encodeURIComponent(id)}/creative`, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    props().creative_url = body.creative_url;
    renderCreative(); updateOverlay(); bumpUpdated();
    setStatus(`Creative saved for ${id}.`);
  } catch (err) { setStatus(`Upload failed: ${err.message}`, "error"); }
});
$("#creative-clear").addEventListener("click", async () => {
  if (!current) return;
  const id = props().id;
  try {
    const r = await fetch(`/api/billboards/${encodeURIComponent(id)}/creative`, { method: "DELETE" });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    delete props().creative_url;
    renderCreative(); updateOverlay(); bumpUpdated();
    setStatus(`Creative removed for ${id}.`);
  } catch (err) { setStatus(`Remove failed: ${err.message}`, "error"); }
});

// ---------- Street View ----------
let mapsJsPromise = null;
function loadMapsJs() {
  if (window.google?.maps?.StreetViewPanorama) return Promise.resolve();
  if (mapsJsPromise) return mapsJsPromise;
  mapsJsPromise = new Promise((resolve, reject) => {
    if (!cfg.googleBrowserKey) return reject(new Error("GOOGLE_BROWSER_KEY missing"));
    window.__mapsReady = resolve;
    const el = document.createElement("script");
    el.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(cfg.googleBrowserKey)}&v=weekly&loading=async&callback=__mapsReady`;
    el.async = true;
    el.onerror = () => { mapsJsPromise = null; reject(new Error("Maps JavaScript API failed to load")); };
    document.head.appendChild(el);
  });
  return mapsJsPromise;
}
function camera() {
  const st = $("#sv-stage");
  return M.svCamera(panorama.getPov(), panorama.getZoom(), st.clientWidth, st.clientHeight);
}
function camPos() { const pos = panorama?.getPosition(); return pos ? { lat: pos.lat(), lng: pos.lng() } : null; }
function povToward(g, from) {
  const dist = M.metresBetween(from, g);
  const heading = M.bearingDeg(from, g);
  const pitch = Math.min((Math.atan2(g.base + g.bh / 2 - M.SV_CAM_HEIGHT, Math.max(dist, 5)) * 180) / Math.PI, 70);
  return { pov: { heading, pitch }, dist, zoom: dist > 80 ? 1.5 : 1 };
}

async function openStreetView() {
  const g = geom();
  if (!g) return;
  $("#sv-empty").hidden = true;
  $("#sv-note").textContent = "Finding panorama…";
  try {
    await loadMapsJs();
    const svc = new google.maps.StreetViewService();
    const panoId = props().sv_pano_id;
    const { data } = await svc.getPanorama(panoId
      ? { pano: panoId }
      : { location: { lat: g.lat, lng: g.lng }, radius: 200, source: google.maps.StreetViewSource.OUTDOOR, preference: google.maps.StreetViewPreference.NEAREST });
    const ll = data.location.latLng;
    const { pov, dist, zoom } = povToward(g, { lat: ll.lat(), lng: ll.lng() });
    panoMeta = { dist, heading: pov.heading, when: data.imageDate || "" };
    if (!panorama) {
      panorama = new google.maps.StreetViewPanorama($("#sv-pano"), {
        pano: data.location.pano, pov, zoom, addressControl: false, fullscreenControl: false, motionTracking: false, showRoadLabels: false,
      });
      for (const ev of ["pov_changed", "zoom_changed", "visible_changed"]) panorama.addListener(ev, updateOverlay);
      for (const ev of ["pano_changed", "position_changed"]) panorama.addListener(ev, onPanoChanged);
      requestAnimationFrame(() => google.maps.event.trigger(panorama, "resize"));
    } else {
      panorama.setPano(data.location.pano);
      panorama.setPov(pov);
      panorama.setZoom(zoom);
    }
    sizeBoardEl();
    updateOverlay(); updateNote(); renderSavedList();
  } catch (e) {
    const msg = String(e?.message || e?.code || e);
    const text = /ZERO_RESULTS/.test(msg) ? "No Street View within 200 m of this board." : `Street View unavailable: ${msg}`;
    $("#sv-note").textContent = text;
    $("#sv-empty").textContent = text; $("#sv-empty").hidden = false;
    $("#sv-board").style.display = "none";
  }
}
function onPanoChanged() {
  if (align.active) setAligning(false); // alignment belongs to one pano
  const g = geom(), from = camPos();
  if (g && from) { panoMeta.dist = M.metresBetween(from, g); }
  updateOverlay(); updateNote(); renderSavedList();
}
function sizeBoardEl() {
  const g = geom(), el = $("#sv-board");
  if (!g) return;
  el.style.width = "200px";
  el.style.height = `${Math.max(20, Math.round(200 * (g.bh / g.bw)))}px`;
}
function updateNote() {
  if (!panorama || !current) return;
  const when = panoMeta.when ? ` · captured ${panoMeta.when}` : "";
  const aligned = !!M.savedCorners(props(), panorama.getPano());
  $("#sv-note").textContent = align.active
    ? "Drag the corners onto the real board, then Save layout."
    : `Panorama ${Math.round(panoMeta.dist)} m from board${when}. ` +
      (aligned ? "Board overlay aligned to this panorama." : "Board overlay is a projection (±few metres). Click Align to pin it exactly.");
}

// Place #sv-board with a homography: aligned corners first, else the geometric projection.
function updateOverlay() {
  const el = $("#sv-board");
  const g = geom(), cam = camPos();
  if (!panorama || !g || !cam || !panorama.getPov()) { el.style.display = "none"; return; }
  const c = camera();
  const handles = document.querySelectorAll(".sv-handle");
  const aligned = align.corners || M.savedCorners(props(), panorama.getPano());
  let pts, back = false, label;
  if (aligned) {
    pts = aligned.map((a) => M.svProject(c, M.angToVec(a)));
    pts.forEach((pt, i) => { const hd = handles[i]; if (pt) { hd.style.left = `${pt[0]}px`; hd.style.top = `${pt[1]}px`; hd.style.visibility = ""; } else hd.style.visibility = "hidden"; });
    if (pts.some((p) => !p)) { el.style.display = "none"; return; }
    label = `${props().id} · ${align.active ? "aligning" : "aligned"}`;
  } else {
    handles.forEach((hd) => { hd.style.visibility = "hidden"; });
    const r = M.projectBoard(g, cam, c);
    if (!r) { el.style.display = "none"; return; }
    pts = r.pts; back = r.back;
    label = `${props().id} · ${g.bw}×${g.bh} m${back ? " · back side" : ""}`;
  }
  el.classList.toggle("back", back);
  $("#sv-board-label").textContent = label;
  const t = M.boardTransform(el, pts);
  if (!t) { el.style.display = "none"; return; }
  el.style.transform = t;
  el.style.display = "block";
}
window.addEventListener("resize", () => { if (panorama) google.maps.event.trigger(panorama, "resize"); updateOverlay(); });

// ---------- Align mode ----------
function setAligning(on) {
  align.active = on;
  $("#sv-overlay").classList.toggle("aligning", on);
  $("#sv-save").hidden = !on; $("#sv-cancel").hidden = !on;
  $("#sv-align").hidden = on;
  if (on) {
    const saved = M.savedCorners(props(), panorama.getPano());
    if (saved) align.corners = saved.map((x) => ({ ...x }));
    else {
      const c = camera(), r = M.projectBoard(geom(), camPos(), c);
      const pov = panorama.getPov();
      align.corners = r
        ? r.pts.map(([x, y]) => M.svUnproject(c, x, y))
        : [[-6, 10], [6, 10], [6, -2], [-6, -2]].map(([dh, dp]) => ({ heading: (pov.heading + dh + 360) % 360, pitch: pov.pitch + dp }));
    }
  } else align.corners = null;
  updateOverlay(); updateNote();
}
(function wireHandles() {
  let drag = null;
  document.querySelectorAll(".sv-handle").forEach((hd) => {
    hd.addEventListener("pointerdown", (e) => { if (!align.active) return; drag = Number(hd.dataset.i); hd.setPointerCapture(e.pointerId); e.preventDefault(); });
    hd.addEventListener("pointermove", (e) => {
      if (drag == null || !align.active) return;
      const r = $("#sv-stage").getBoundingClientRect();
      align.corners[drag] = M.svUnproject(camera(), e.clientX - r.left, e.clientY - r.top);
      updateOverlay();
    });
    const end = () => { drag = null; };
    hd.addEventListener("pointerup", end); hd.addEventListener("pointercancel", end);
  });
})();
$("#sv-align").addEventListener("click", () => { if (panorama && current) setAligning(true); });
$("#sv-cancel").addEventListener("click", () => setAligning(false));
// AI prefill: the server finds the board face in a Street View Static view of this pano and returns corners.
// They go into the handles only; nothing is saved until the user clicks Save layout.
$("#sv-auto").addEventListener("click", async () => {
  if (!panorama || !current) return;
  const pano = panorama.getPano(), pov = panorama.getPov();
  if (!pano || !pov) return setStatus("Street View is not ready yet.", "error");
  const btn = $("#sv-auto");
  btn.disabled = true; setStatus("Auto-aligning with AI…");
  try {
    const r = await fetch(`/api/billboards/${encodeURIComponent(props().id)}/auto-align`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pano_id: pano, heading: pov.heading, pitch: pov.pitch, zoom: panorama.getZoom() ?? 1 }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    if (!align.active) setAligning(true);
    align.corners = j.corners;
    updateOverlay();
    const conf = j.confidence != null ? ` (confidence ${Math.round(j.confidence * 100)}%)` : "";
    const warn = j.warnings?.length ? ` ${j.warnings.join(" ")}` : "";
    setStatus(`AI placed the corners${conf}. Check the yellow handles, adjust if needed, then Save layout.${warn}`, warn ? "error" : "ok");
  } catch (e) {
    setStatus(`Auto-align failed: ${e.message}`, "error");
  } finally {
    btn.disabled = false;
  }
});
$("#sv-look").addEventListener("click", () => {
  const g = geom(), from = camPos();
  if (!g || !from) return;
  const { pov, zoom } = povToward(g, from);
  panorama.setPov(pov); panorama.setZoom(zoom);
});

async function putAlignment(id, body) {
  const r = await fetch(`/api/billboards/${encodeURIComponent(id)}/streetview`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const res = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(res.error || `HTTP ${r.status}`);
  return res;
}
function applyRecord(res) {
  Object.assign(current.properties, res.properties);
  for (const k of Object.keys(current.properties)) if (!(k in res.properties)) delete current.properties[k];
  if (res.coordinates) current.geometry.coordinates = res.coordinates;
  sizeBoardEl(); renderGeom(); renderSavedList(); renderBoardList(); bumpUpdated();
}

$("#sv-save").addEventListener("click", async () => {
  if (!current || !align.corners) return;
  const id = props().id, pano = panorama.getPano(), cam = camPos();
  const { fit, method } = M.fitFromAlignments(props(), pano, align.corners, cam);
  try {
    const res = await putAlignment(id, {
      pano_id: pano, pano_lat: cam.lat, pano_lng: cam.lng, corners: align.corners,
      geometry: fit ? { lat: fit.lat, lng: fit.lng, base_height_m: fit.base_height_m, board_height_m: fit.board_height_m, width_m: fit.width_m, heading_deg: fit.heading_deg } : undefined,
    });
    applyRecord(res);
    setAligning(false);
    setStatus(fit
      ? `Layout saved. 3D geometry ${method}: ${Math.round(fit.distance)} m from this pano, base ${fit.base_height_m.toFixed(1)} m, ${fit.width_m.toFixed(1)}×${fit.board_height_m.toFixed(1)} m, facing ${Math.round(fit.heading_deg)}°${fit.rmsDeg != null ? `, residual ${fit.rmsDeg.toFixed(2)}°` : ""}.`
      : `Layout saved for ${id} on this panorama.`);
  } catch (e) { setStatus(`Save failed: ${e.message}`, "error"); }
});

// Recompute the 3D record from every saved alignment (rectangle fit across panos, single-pano fit for one).
async function refitGeometry(quiet = false) {
  const p = props(), entries = Object.entries(p.sv_alignments || {}).filter(([, a]) => a && !Array.isArray(a) && Number.isFinite(a.lat));
  if (!entries.length) { if (!quiet) setStatus("No saved panoramas with a position to fit from.", "error"); return; }
  const { fit, method } = M.fitFromAlignments(p, null, null, null);
  if (!fit) { setStatus("Fit failed: corners too close together.", "error"); return; }
  const [pid, a] = entries.find(([pid]) => pid === p.sv_pano_id) || entries[0];
  try {
    const res = await putAlignment(p.id, {
      pano_id: pid, corners: a.corners, pano_lat: a.lat, pano_lng: a.lng,
      geometry: { lat: fit.lat, lng: fit.lng, base_height_m: fit.base_height_m, board_height_m: fit.board_height_m, width_m: fit.width_m, heading_deg: fit.heading_deg },
    });
    applyRecord(res); updateOverlay();
    setStatus(`Geometry ${method}: base ${fit.base_height_m.toFixed(1)} m, ${fit.width_m.toFixed(1)}×${fit.board_height_m.toFixed(1)} m, facing ${Math.round(fit.heading_deg)}°${fit.rmsDeg != null ? `, residual ${fit.rmsDeg.toFixed(2)}°` : ""}.`);
  } catch (e) { setStatus(`Refit failed: ${e.message}`, "error"); }
}
$("#sv-refit").addEventListener("click", () => refitGeometry());

// Saved panoramas: jump to one, make it the default (used by the viewer and the card photo), or clear it.
function renderSavedList() {
  const p = props(), ul = $("#sv-list");
  const here = panorama?.getPano();
  const entries = Object.entries(p.sv_alignments || {});
  if (!entries.length) { ul.innerHTML = `<li class="empty">None yet. Align the board and save.</li>`; return; }
  ul.innerHTML = entries.map(([pid, a]) => {
    const hasPos = a && !Array.isArray(a) && Number.isFinite(a.lat);
    return `<li class="${pid === here ? "here" : ""}" data-pid="${esc(pid)}">
      <span class="pid" title="${esc(pid)}">${esc(pid)}</span>
      ${pid === p.sv_pano_id ? `<span class="tag">default</span>` : `<button type="button" class="secondary" data-act="default" title="Use this panorama in the viewer and the card photo">Set default</button>`}
      ${pid === here ? "" : `<button type="button" class="secondary" data-act="go">Go</button>`}
      <button type="button" class="secondary" data-act="clear" title="Remove this alignment${hasPos ? "" : " (no position stored)"}">&times;</button>
    </li>`;
  }).join("");
}
$("#sv-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]"); if (!btn) return;
  const pid = btn.closest("li")?.dataset.pid, id = props().id, a = props().sv_alignments?.[pid];
  if (!pid || !current) return;
  try {
    if (btn.dataset.act === "go") {
      panorama.setPano(pid);
      const g = geom();
      google.maps.event.addListenerOnce(panorama, "position_changed", () => { const from = camPos(); if (from) { const { pov } = povToward(g, from); panorama.setPov(pov); } });
    } else if (btn.dataset.act === "default") {
      const corners = Array.isArray(a) ? a : a?.corners;
      const res = await putAlignment(id, { pano_id: pid, corners, pano_lat: a?.lat, pano_lng: a?.lng, set_default: true });
      applyRecord(res); setStatus(`Default panorama set.`);
    } else if (btn.dataset.act === "clear") {
      if (!confirm(`Remove the saved alignment for panorama ${pid}?`)) return;
      const res = await putAlignment(id, { pano_id: pid, corners: null });
      applyRecord(res); updateOverlay(); updateNote(); setStatus(`Alignment removed for ${pid}.`);
      await refitGeometry(true);
    }
  } catch (err) { setStatus(`Failed: ${err.message}`, "error"); }
});

// ---------- Boot ----------
try {
  await loadBoards();
  const q = new URLSearchParams(location.search).get("id");
  if (q && boards.some((f) => f.properties.id === q)) await openBoard(q); // deep link opens the product view
  else showCatalog();
  if (!boards.length) setStatus("No billboards in data/billboards.geojson.", "error");
} catch (e) { setStatus(`Could not load billboards: ${e.message}`, "error"); }
