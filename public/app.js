/* global Cesium */
import * as M from "./sv-math.js";
const { R_EARTH, SV_CAM_HEIGHT, metresBetween, bearingDeg } = M;
const cfg = window.APP_CONFIG || {};
const $ = (s) => document.querySelector(s);
const statusEl = $("#status");

let fatal = false;
// Status line shows errors only; informational messages go to the console.
function setStatus(msg, isError = false, sticky = false) {
  if (fatal && !isError) return; // keep fatal setup errors visible
  if (sticky) fatal = true;
  if (!isError) { console.info(msg); return; }
  statusEl.textContent = msg;
  statusEl.hidden = false;
  statusEl.classList.add("error");
}

// ---------- Viewer ----------
Cesium.GoogleMaps.defaultApiKey = cfg.googleBrowserKey || undefined;

// Phones (narrow or touch-first) get a cheaper render profile; desktop keeps full detail.
const IS_MOBILE = matchMedia("(max-width: 719px), (pointer: coarse)").matches;

const viewer = new Cesium.Viewer("viewer", {
  globe: false, // Google tiles include terrain
  baseLayerPicker: false,
  geocoder: false,
  timeline: false,
  animation: false,
  homeButton: false,
  sceneModePicker: false,
  navigationHelpButton: false,
  infoBox: false,
  selectionIndicator: false,
  fullscreenButton: false,
  requestRenderMode: true, // render only on camera/tile change, not every frame
  maximumRenderTimeChange: Infinity,
  useBrowserRecommendedResolution: false,
});
// GPU fill cost scales with pixel count: phones render at 0.6 (DPR 3 phones still look sharp), desktop at 0.75.
viewer.resolutionScale = IS_MOBILE ? 0.6 : 0.75;
viewer.scene.skyAtmosphere.show = false; // per-frame shader cost, not needed for the map
window.viewer = viewer;

const CHENNAI = { lng: 80.2707, lat: 13.0827 };
const DEFAULT_BILLBOARD = new URLSearchParams(location.search).get("id") || "BB-ADY-004"; // board shown on load (?id= overrides)

function flyTo(lng, lat, height = 1500, pitchDeg = -35) {
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lng, lat, height),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(pitchDeg), roll: 0 },
    duration: 1.5,
  });
}

async function loadTiles() {
  if (!cfg.googleBrowserKey) {
    setStatus("GOOGLE_BROWSER_KEY missing. Copy .env.example to .env and set keys.", true, true);
    return;
  }
  try {
    // Higher SSE = fewer tiles loaded (less VRAM/RAM). Default is 16. Phones get a coarser mesh.
    const tileset = await Cesium.createGooglePhotorealistic3DTileset({ maximumScreenSpaceError: IS_MOBILE ? 48 : 32 });
    viewer.scene.primitives.add(tileset);
    setStatus("3D tiles loaded.");
  } catch (e) {
    console.error(e);
    setStatus(`3D tiles failed: ${e.message || e}`, true, true);
  }
}

// ---------- Helpers ----------
const cartoOf = (c) => Cesium.Cartographic.fromCartesian(c);
const fmtM = (m) => `${m.toFixed(1)} m`;

// Google encoded polyline (precision 5) → [{lng,lat}]
function decodePolyline(str) {
  const out = [];
  let index = 0, lat = 0, lng = 0;
  while (index < str.length) {
    for (const which of ["lat", "lng"]) {
      let shift = 0, result = 0, b;
      do {
        b = str.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === "lat") lat += d; else lng += d;
    }
    out.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return out;
}

// Clamp lon/lat points onto the Google mesh. Returns Cartesian3[] with `offset` metres added.
async function clampPoints(lngLats, offset = 0, fallbackHeight = 20) {
  const cartesians = lngLats.map((p) => Cesium.Cartesian3.fromDegrees(p.lng, p.lat, 0));
  let clamped;
  try {
    clamped = await viewer.scene.clampToHeightMostDetailed(cartesians);
  } catch (e) {
    console.warn("clampToHeightMostDetailed failed; using fallback height", e);
    clamped = cartesians.map(() => undefined);
  }
  return clamped.map((c, i) => {
    const h = c ? cartoOf(c).height : fallbackHeight;
    return Cesium.Cartesian3.fromDegrees(lngLats[i].lng, lngLats[i].lat, h + offset);
  });
}

async function getJson(url) {
  const r = await fetch(url);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}

// ---------- Layers ----------
const layers = {};

function defineLayer(name, { refreshMs, load, unload }) {
  const ds = new Cesium.CustomDataSource(name);
  viewer.dataSources.add(ds);
  layers[name] = { ds, refreshMs, load, unload, timer: null, on: false };
}

async function setLayer(name, on) {
  const L = layers[name];
  if (!L || L.on === on) return;
  L.on = on;
  L.ds.show = on;
  if (on) {
    const run = async () => {
      try {
        await L.load(L.ds);
      } catch (e) {
        console.error(name, e);
        setStatus(`${name}: ${e.message}`, true);
      }
    };
    await run();
    if (L.refreshMs) L.timer = setInterval(run, L.refreshMs);
  } else {
    clearInterval(L.timer);
    L.timer = null;
    L.ds.entities.removeAll();
    L.unload?.();
  }
}

// Traffic: colored corridors from Routes API
defineLayer("traffic", {
  refreshMs: 3 * 60 * 1000,
  async load(ds) {
    const data = await getJson("/api/traffic");
    ds.entities.removeAll();
    for (const r of data.routes) {
      if (r.error || !r.polyline) { console.warn("traffic", r.id, r.error); continue; }
      const pts = decodePolyline(r.polyline);
      const positions = await clampPoints(pts, 6);
      const ratio = r.ratio || 1;
      const color = ratio < 1.2 ? Cesium.Color.LIME : ratio < 1.6 ? Cesium.Color.ORANGE : Cesium.Color.RED;
      ds.entities.add({
        name: r.name,
        polyline: { positions, width: 7, material: color.withAlpha(0.9) },
      });
      const mid = positions[Math.floor(positions.length / 2)];
      const mins = Math.round(r.duration / 60);
      const delta = Math.round((ratio - 1) * 100);
      ds.entities.add({
        position: mid,
        label: {
          text: `${r.name}\n${mins} min (${delta >= 0 ? "+" : ""}${delta}%)`,
          font: "13px sans-serif",
          fillColor: Cesium.Color.WHITE,
          showBackground: true,
          backgroundColor: color.withAlpha(0.7),
          pixelOffset: new Cesium.Cartesian2(0, -20),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(500, 1.0, 20000, 0.5),
        },
      });
    }
    setStatus(`Traffic updated ${new Date(data.fetchedAt).toLocaleTimeString()}`);
  },
});

// Air quality: colored markers
defineLayer("air", {
  refreshMs: 20 * 60 * 1000,
  async load(ds) {
    const data = await getJson("/api/air");
    ds.entities.removeAll();
    const pts = data.points.filter((p) => !p.error);
    const positions = await clampPoints(pts.map((p) => ({ lng: p.longitude, lat: p.latitude })), 60);
    pts.forEach((p, i) => {
      const c = p.color
        ? new Cesium.Color(p.color.red ?? 0, p.color.green ?? 0, p.color.blue ?? 0, 1)
        : Cesium.Color.GRAY;
      ds.entities.add({
        position: positions[i],
        point: { pixelSize: 18, color: c, outlineColor: Cesium.Color.BLACK, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: {
          text: `${p.name}\nAQI ${p.aqi ?? "?"} · ${p.category ?? ""}\n${p.dominantPollutant ?? ""}`,
          font: "12px sans-serif",
          fillColor: Cesium.Color.WHITE,
          showBackground: true,
          backgroundColor: Cesium.Color.BLACK.withAlpha(0.6),
          pixelOffset: new Cesium.Cartesian2(0, -28),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      // Drop line to ground for context
      const groundPos = Cesium.Cartesian3.fromDegrees(p.longitude, p.latitude, cartoOf(positions[i]).height - 60);
      ds.entities.add({ polyline: { positions: [groundPos, positions[i]], width: 1.5, material: c.withAlpha(0.6) } });
    });
    setStatus(`Air quality updated ${new Date(data.fetchedAt).toLocaleTimeString()}`);
  },
});

// Weather: compact widget on right edge, click to expand
const WX_EMOJI = {
  CLEAR: "\u2600\uFE0F", MOSTLY_CLEAR: "\uD83C\uDF24\uFE0F", PARTLY_CLOUDY: "\u26C5", MOSTLY_CLOUDY: "\uD83C\uDF25\uFE0F", CLOUDY: "\u2601\uFE0F",
  WINDY: "\uD83C\uDF2C\uFE0F", WIND_AND_RAIN: "\uD83C\uDF27\uFE0F", LIGHT_RAIN_SHOWERS: "\uD83C\uDF26\uFE0F", CHANCE_OF_SHOWERS: "\uD83C\uDF26\uFE0F",
  SCATTERED_SHOWERS: "\uD83C\uDF26\uFE0F", RAIN_SHOWERS: "\uD83C\uDF27\uFE0F", HEAVY_RAIN_SHOWERS: "\uD83C\uDF27\uFE0F", LIGHT_TO_MODERATE_RAIN: "\uD83C\uDF27\uFE0F",
  MODERATE_TO_HEAVY_RAIN: "\uD83C\uDF27\uFE0F", RAIN: "\uD83C\uDF27\uFE0F", LIGHT_RAIN: "\uD83C\uDF26\uFE0F", HEAVY_RAIN: "\uD83C\uDF27\uFE0F",
  RAIN_PERIODICALLY_HEAVY: "\uD83C\uDF27\uFE0F", THUNDERSTORM: "\u26C8\uFE0F", THUNDERSHOWER: "\u26C8\uFE0F", LIGHT_THUNDERSTORM_RAIN: "\u26C8\uFE0F",
  SCATTERED_THUNDERSTORMS: "\u26C8\uFE0F", HEAVY_THUNDERSTORM: "\u26C8\uFE0F", HAIL: "\uD83C\uDF28\uFE0F", SNOW: "\uD83C\uDF28\uFE0F",
};

// Location the right-hand widget describes. Defaults to central Chennai; search changes it.
const hud = { name: "Chennai", address: "", lat: CHENNAI.lat, lng: CHENNAI.lng, weather: null, air: null };

function renderHud() {
  const w = hud.weather, a = hud.air;
  const widget = $("#weather-widget");
  const img = $("#wx-icon");
  const emoji = $("#wx-emoji");
  if (w?.iconBaseUri) {
    img.src = `${w.iconBaseUri}.svg`;
    img.hidden = false;
    emoji.hidden = true;
    img.onerror = () => { img.hidden = true; emoji.hidden = false; };
  } else {
    img.hidden = true;
    emoji.hidden = false;
  }
  emoji.textContent = WX_EMOJI[w?.conditionType] || "\uD83C\uDF21\uFE0F";
  $("#wx-temp").textContent = w?.temperatureC != null ? `${w.temperatureC}\u00B0C` : "\u2013";
  $("#wx-cond").textContent = w?.condition || (w?.error ? "Weather n/a" : "");

  const aqiEl = $("#wx-aqi");
  if (a?.aqi != null) {
    const c = a.color ? `rgb(${Math.round((a.color.red ?? 0) * 255)},${Math.round((a.color.green ?? 0) * 255)},${Math.round((a.color.blue ?? 0) * 255)})` : "#888";
    aqiEl.innerHTML = `<span class="dot" style="background:${c}"></span>AQI ${a.aqi} \u00B7 ${a.category ?? ""}`;
  } else {
    aqiEl.textContent = a?.error ? "AQI n/a" : "";
  }
  $("#wx-place").innerHTML = `<b>${hud.name}</b>${hud.address ? `<br>${hud.address}` : ""}`;

  const wxRows = [
    w?.feelsLikeC != null ? `Feels like ${w.feelsLikeC}\u00B0C` : null,
    w?.humidityPct != null ? `Humidity ${w.humidityPct}%` : null,
    w?.windKmh != null ? `Wind ${w.windKmh} km/h ${w.windDir ?? ""}` : null,
    w?.precipProbabilityPct != null ? `Rain chance ${w.precipProbabilityPct}%` : null,
    w?.uvIndex != null ? `UV ${w.uvIndex}` : null,
  ].filter(Boolean);
  const airRows = [
    a?.dominantPollutant ? `Dominant pollutant ${a.dominantPollutant}` : null,
    a?.localAqi?.aqi != null ? `India AQI (${a.localAqi.code}) ${a.localAqi.aqi} \u00B7 ${a.localAqi.category ?? ""}` : null,
  ].filter(Boolean);
  $("#wx-detail").innerHTML =
    `<h4>Weather</h4>` + wxRows.map((r) => `<div>${r}</div>`).join("") +
    (airRows.length ? `<h4>Air quality</h4>` + airRows.map((r) => `<div>${r}</div>`).join("") : "") +
    `<div class="muted">${hud.lat.toFixed(4)}, ${hud.lng.toFixed(4)} \u00B7 ${w?.time ? new Date(w.time).toLocaleString() : ""}</div>`;
  widget.hidden = false;
}

async function refreshHud() {
  const q = `lat=${hud.lat}&lng=${hud.lng}&name=${encodeURIComponent(hud.name)}`;
  const [w, a] = await Promise.allSettled([getJson(`/api/weather?${q}`), getJson(`/api/air/point?${q}`)]);
  hud.weather = w.status === "fulfilled" ? w.value : { error: w.reason?.message };
  hud.air = a.status === "fulfilled" ? a.value : { error: a.reason?.message };
  renderHud();
}

function setHudLocation({ name, address, lat, lng }) {
  Object.assign(hud, { name, address: address || "", lat, lng });
  renderHud();
  refreshHud();
}

$("#weather-widget").addEventListener("click", () => {
  const el = $("#weather-widget");
  el.setAttribute("aria-expanded", el.getAttribute("aria-expanded") === "true" ? "false" : "true");
});

defineLayer("weather", {
  refreshMs: 20 * 60 * 1000,
  async load() {
    await refreshHud();
  },
  unload() {
    $("#weather-widget").hidden = true;
  },
});

// Billboards: own GeoJSON → boxes on the mesh
const billboardEntities = new Map(); // id → box entity
const billboardCreatives = new Map(); // id → creative URL (served from /creatives)
const billboardGeom = new Map(); // id → { lng, lat, groundH, base, bh, bw, heading }
const billboardSpeed = new Map(); // id → { speedKmh, freeFlowKmh, sampledAt }
const billboardLabels = new Map(); // id → label entity
const billboardProps = new Map(); // id → GeoJSON properties
const BOARD_MATERIAL = Cesium.Color.DEEPSKYBLUE.withAlpha(0.55);

function applyCreative(id, url) {
  const ent = billboardEntities.get(id);
  if (!ent) return;
  if (url) {
    ent.box.material = new Cesium.ImageMaterialProperty({ image: url, transparent: false });
    ent.box.outlineColor = Cesium.Color.WHITE;
  } else {
    ent.box.material = BOARD_MATERIAL;
  }
}
defineLayer("billboards", {
  refreshMs: 0,
  async load(ds) {
    const geo = await getJson("/api/billboards");
    ds.entities.removeAll();
    const feats = geo.features.filter((f) => f.geometry?.type === "Point");
    const ll = feats.map((f) => ({ lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }));
    const ground = await clampPoints(ll, 0);
    feats.forEach((f, i) => {
      const p = f.properties || {};
      const base = Number(p.base_height_m) || 0;
      const bh = Number(p.board_height_m) || 3;
      const bw = Number(p.width_m) || 6;
      const groundH = cartoOf(ground[i]).height;
      const center = Cesium.Cartesian3.fromDegrees(ll[i].lng, ll[i].lat, groundH + base + bh / 2);
      const heading = Cesium.Math.toRadians(Number(p.heading_deg) || 0);
      const orientation = Cesium.Transforms.headingPitchRollQuaternion(center, new Cesium.HeadingPitchRoll(heading, 0, 0));
      const boxEnt = ds.entities.add({
        name: p.id,
        position: center,
        orientation,
        box: {
          dimensions: new Cesium.Cartesian3(bw, 0.4, bh),
          material: BOARD_MATERIAL,
          outline: true,
          outlineColor: Cesium.Color.WHITE,
        },
        label: {
          text: `${p.name ? `${p.name}\n` : ""}${p.id ?? "billboard"}\n${bw}×${bh} m @ ${base} m`,
          font: "12px sans-serif",
          fillColor: Cesium.Color.WHITE,
          showBackground: true,
          backgroundColor: Cesium.Color.BLACK.withAlpha(0.6),
          pixelOffset: new Cesium.Cartesian2(0, -30),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(300, 1.0, 8000, 0.4),
        },
        properties: { billboard: p },
      });
      if (p.id) {
        billboardEntities.set(p.id, boxEnt);
        billboardGeom.set(p.id, { lng: ll[i].lng, lat: ll[i].lat, groundH, base, bh, bw, heading: Number(p.heading_deg) || 0 });
        billboardLabels.set(p.id, boxEnt);
        billboardProps.set(p.id, p);
        refreshSpeed(p.id);
        if (p.creative_url) billboardCreatives.set(p.id, p.creative_url);
        else billboardCreatives.delete(p.id);
        if (billboardCreatives.has(p.id)) applyCreative(p.id, billboardCreatives.get(p.id));
      }
      // Pole from ground to board base
      ds.entities.add({
        polyline: {
          positions: [ground[i], Cesium.Cartesian3.fromDegrees(ll[i].lng, ll[i].lat, groundH + base)],
          width: 2,
          material: Cesium.Color.WHITE.withAlpha(0.7),
        },
      });
    });
    // Default board on load: DEFAULT_BILLBOARD, else the first one
    if (feats.length && $("#billboard-box").hidden) {
      const def = feats.find((f) => f.properties?.id === DEFAULT_BILLBOARD) || feats[0];
      const p = def.properties;
      showBillboard(p);
      overviewBillboard(p.id);
      const g = billboardGeom.get(p.id);
      if (g) setHudLocation({ name: p.name || p.id, address: [p.type, p.owner].filter(Boolean).join(" \u00B7 "), lat: g.lat, lng: g.lng });
    }
    setStatus(`Loaded ${feats.length} billboards.`);
  },
  unload() {
    $("#billboard-box").hidden = true;
  },
});

// Metro Blue Line: elevated viaduct + tunnel sections + stations (OSM data).
// Only stations are clamped to the mesh (26 points). Track vertices take the height of the
// nearest station: Chennai is flat, and clamping every vertex along 45 km floods the tile loader.
defineLayer("metro-blue", {
  refreshMs: 0,
  async load(ds) {
    const geo = await getJson("/api/metro/blue");
    ds.entities.removeAll();
    const colour = Cesium.Color.fromCssColorString(geo.colour || "#3281c4");
    const tracks = geo.features.filter((f) => f.properties.kind === "track");
    const stations = geo.features.filter((f) => f.properties.kind === "station");

    const sll = stations.map((f) => ({ lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }));
    const sground = await clampPoints(sll, 0);
    const sheights = sground.map((c) => cartoOf(c).height);
    const groundAt = (lng, lat) => {
      let best = 0, bestD = Infinity;
      for (let i = 0; i < sll.length; i++) {
        const d = (sll[i].lng - lng) ** 2 + (sll[i].lat - lat) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      }
      return sheights[best];
    };

    for (const f of tracks) {
      const tunnel = !!f.properties.tunnel;
      const lift = tunnel ? 1.5 : 10;
      const positions = f.geometry.coordinates.map(([lng, lat]) =>
        Cesium.Cartesian3.fromDegrees(lng, lat, groundAt(lng, lat) + lift));
      ds.entities.add({
        name: tunnel ? "Blue Line (underground)" : "Blue Line (elevated)",
        polyline: {
          positions,
          width: tunnel ? 5 : 8,
          material: tunnel
            ? new Cesium.PolylineDashMaterialProperty({ color: colour.withAlpha(0.85), dashLength: 24 })
            : colour.withAlpha(0.95),
        },
      });
    }

    stations.forEach((f, i) => {
      const p = f.properties;
      ds.entities.add({
        name: p.name,
        position: Cesium.Cartesian3.fromDegrees(sll[i].lng, sll[i].lat, sheights[i] + 14),
        point: { pixelSize: 11, color: Cesium.Color.WHITE, outlineColor: colour, outlineWidth: 4, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: {
          text: p.name,
          font: "12px sans-serif",
          fillColor: Cesium.Color.WHITE,
          showBackground: true,
          backgroundColor: colour.withAlpha(0.8),
          pixelOffset: new Cesium.Cartesian2(0, -16),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(1000, 1.0, 15000, 0.5),
          translucencyByDistance: new Cesium.NearFarScalar(8000, 1.0, 25000, 0.0),
        },
      });
    });
    setStatus(`Metro Blue Line: ${stations.length} stations.`);
  },
});

// ---------- Billboard traffic speed ----------
function speedText(sp) {
  if (!sp) return "";
  const slow = sp.freeFlowKmh ? sp.speedKmh / sp.freeFlowKmh : 1;
  const tag = slow < 0.6 ? "jam" : slow < 0.85 ? "slow" : "free";
  return `${sp.speedKmh} km/h (${tag}, typical ${sp.freeFlowKmh})`;
}

function baseLabel(id) {
  const g = billboardGeom.get(id);
  const name = billboardProps.get(id)?.name;
  return `${name ? `${name}\n` : ""}${id}\n${g.bw}×${g.bh} m @ ${g.base} m`;
}

async function refreshSpeed(id) {
  try {
    const sp = await getJson(`/api/billboards/${encodeURIComponent(id)}/speed`);
    billboardSpeed.set(id, sp);
  } catch (e) {
    billboardSpeed.set(id, { error: e.message });
  }
  const ent = billboardLabels.get(id);
  const sp = billboardSpeed.get(id);
  if (ent?.label) ent.label.text = baseLabel(id) + (sp?.speedKmh ? `\n\u{1F697} ${sp.speedKmh} km/h` : "");
  const card = $("#speed-cell");
  if (card && card.dataset.id === id) card.textContent = sp?.speedKmh ? speedText(sp) : `n/a (${sp?.error ?? "?"})`;

}
setInterval(() => { for (const id of billboardGeom.keys()) refreshSpeed(id); }, 3 * 60 * 1000);

// ---------- Billboard camera views ----------
const driverState = { id: null, flipped: false };
const EYE_HEIGHT = 1.4; // car driver eye level, metres above road
const DRIVER_FAR = 120;
const DRIVER_NEAR = 45;
const DRIVER_MAX_PITCH = Cesium.Math.toRadians(10); // windshield view, not craning up

function boardCenter(g) {
  return Cesium.Cartesian3.fromDegrees(g.lng, g.lat, g.groundH + g.base + g.bh / 2);
}

function overviewBillboard(id) {
  const g = billboardGeom.get(id);
  if (!g) return;
  driverState.id = null;
  viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(boardCenter(g), 40), {
    offset: new Cesium.HeadingPitchRange(Cesium.Math.toRadians(g.heading + 180), Cesium.Math.toRadians(-20), 160),
    duration: 1.5,
  });
}

// Point `dist` metres from the board along its facing direction (or the opposite side when flipped).
function roadPoint(g, dist, flipped) {
  const dir = Cesium.Math.toRadians(g.heading + (flipped ? 180 : 0));
  const R = 6378137;
  const dLat = (dist * Math.cos(dir)) / R;
  const dLng = (dist * Math.sin(dir)) / (R * Math.cos(Cesium.Math.toRadians(g.lat)));
  return { lng: g.lng + Cesium.Math.toDegrees(dLng), lat: g.lat + Cesium.Math.toDegrees(dLat) };
}

// --- road geometry helpers: metresBetween/bearingDeg come from sv-math ---
// Walk `back` metres backwards along `pts` from vertex `idx`; returns point + travel heading.
function pointBehind(pts, idx, back) {
  let i = idx, remaining = back;
  while (i > 0) {
    const seg = metresBetween(pts[i - 1], pts[i]);
    if (seg >= remaining) {
      const t = seg ? 1 - remaining / seg : 1;
      const p = { lng: pts[i - 1].lng + (pts[i].lng - pts[i - 1].lng) * t, lat: pts[i - 1].lat + (pts[i].lat - pts[i - 1].lat) * t };
      return { ...p, heading: bearingDeg(pts[i - 1], pts[i]) };
    }
    remaining -= seg;
    i--;
  }
  return { ...pts[0], heading: pts.length > 1 ? bearingDeg(pts[0], pts[1]) : 0 };
}

// Road track past the board from the speed sample (Routes API polyline), per direction.
function roadTrack(id, flipped) {
  const sp = billboardSpeed.get(id);
  const polys = (sp?.polylines || []).filter(Boolean);
  if (!polys.length) return null;
  const g = billboardGeom.get(id);
  const pts = decodePolyline(polys[flipped && polys.length > 1 ? 1 : 0]);
  if (pts.length < 2) return null;
  let passIdx = 0, best = Infinity;
  pts.forEach((p, i) => { const d = metresBetween(p, g); if (d < best) { best = d; passIdx = i; } });
  return { pts, passIdx, lateralM: best };
}

async function driverPose(g, dist, flipped, track) {
  let pt, heading;
  if (track) {
    const p = pointBehind(track.pts, track.passIdx, dist);
    pt = { lng: p.lng, lat: p.lat };
    heading = p.heading; // look along the road, board comes up ahead/beside
  } else {
    pt = roadPoint(g, dist, flipped); // fallback: straight out from the board face
    heading = g.heading + (flipped ? 0 : 180);
  }
  const [ground] = await clampPoints([pt], 0, g.groundH);
  const eyeH = cartoOf(ground).height + EYE_HEIGHT;
  const boardH = g.groundH + g.base + g.bh / 2;
  return {
    destination: Cesium.Cartesian3.fromDegrees(pt.lng, pt.lat, eyeH),
    orientation: {
      heading: Cesium.Math.toRadians(heading),
      pitch: Math.min(Math.atan2(boardH - eyeH, dist), DRIVER_MAX_PITCH),
      roll: 0,
    },
  };
}

async function driverView(id, { animate = false, flipped = driverState.flipped } = {}) {
  const g = billboardGeom.get(id);
  if (!g) return;
  driverState.id = id;
  driverState.flipped = flipped;
  setStatus("Driver view: placing camera…");
  const track = roadTrack(id, flipped);
  const where = track ? `on road (${Math.round(track.lateralM)} m from board)` : "in front of board (no road data yet)";
  const far = await driverPose(g, DRIVER_FAR, flipped, track);
  if (!animate) {
    viewer.camera.flyTo({ ...far, duration: 1.2 });
    setStatus(`Driver view ${where}, ${DRIVER_FAR} m out, eye ${EYE_HEIGHT} m.`);
    return;
  }
  const near = await driverPose(g, DRIVER_NEAR, flipped, track);
  viewer.camera.setView(far);
  viewer.camera.flyTo({
    ...near,
    duration: 6,
    easingFunction: Cesium.EasingFunction.LINEAR_NONE,
    complete: () => setStatus(`Driver view: stopped ${DRIVER_NEAR} m from ${id}.`),
  });
  setStatus(`Driving toward ${id} at ~${Math.round((DRIVER_FAR - DRIVER_NEAR) / 6 * 3.6)} km/h…`);
}

// ---------- Street View (view only; creatives and alignment are edited in admin.html) ----------
let mapsJsPromise = null;
function loadMapsJs() {
  if (window.google?.maps?.StreetViewPanorama) return Promise.resolve();
  if (mapsJsPromise) return mapsJsPromise;
  mapsJsPromise = new Promise((resolve, reject) => {
    if (!cfg.googleBrowserKey) return reject(new Error("no browser key"));
    window.__mapsReady = resolve;
    const el = document.createElement("script");
    el.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(cfg.googleBrowserKey)}&v=weekly&loading=async&callback=__mapsReady`;
    el.async = true;
    el.onerror = () => { mapsJsPromise = null; reject(new Error("Maps JavaScript API failed to load")); };
    document.head.appendChild(el);
  });
  return mapsJsPromise;
}

let panorama = null;
const SV_RADIUS_M = 200;
let svBoardId = null;

function svAlignedCorners() {
  if (!panorama) return null;
  return M.savedCorners(billboardProps.get(svBoardId), panorama.getPano());
}

// Place #sv-board over the board with a CSS homography: saved alignment first, else geometric projection.
function svUpdateOverlay() {
  const el = $("#sv-board");
  const g = svBoardId && billboardGeom.get(svBoardId);
  if (!panorama || !g) { el.style.display = "none"; return; }
  const pos = panorama.getPosition(), pov = panorama.getPov();
  if (!pos || !pov) { el.style.display = "none"; return; }
  const stage = $("#sv-stage");
  const c = M.svCamera(pov, panorama.getZoom(), stage.clientWidth, stage.clientHeight);
  const cam = { lng: pos.lng(), lat: pos.lat() };
  let pts, back = false, label;
  const aligned = svAlignedCorners();
  if (aligned) {
    pts = aligned.map((a) => M.svProject(c, M.angToVec(a)));
    if (pts.some((p) => !p)) { el.style.display = "none"; return; }
    label = `${svBoardId} · aligned`;
  } else {
    const r = M.projectBoard(g, cam, c);
    if (!r) { el.style.display = "none"; return; }
    pts = r.pts; back = r.back;
    label = `${svBoardId} · ${g.bw}×${g.bh} m${back ? " · back side" : ""}`;
  }
  el.classList.toggle("back", back);
  $("#sv-board-label").textContent = label;
  const t = M.boardTransform(el, pts);
  if (!t) { el.style.display = "none"; return; }
  el.style.transform = t;
  el.style.display = "block";
}

// Re-read billboards so 3D boxes, geometry and projections reflect the saved record.
async function reloadBillboards(keepId) {
  await layers.billboards.load(layers.billboards.ds);
  const p = billboardProps.get(keepId);
  if (p) { showBillboard(p); svSetBoard(keepId); }
}

function svSetBoard(id) {
  svBoardId = id;
  const el = $("#sv-board");
  const g = billboardGeom.get(id);
  const url = billboardCreatives.get(id);
  el.classList.toggle("has-creative", !!url);
  el.style.backgroundImage = url ? `url("${url}")` : "";
  // keep the element's aspect equal to the board's so the creative isn't distorted twice
  el.style.width = "200px";
  el.style.height = `${Math.max(20, Math.round(200 * (g.bh / g.bw)))}px`;
  svUpdateOverlay();
}
window.addEventListener("resize", svUpdateOverlay);


async function openStreetView(id) {
  const g = billboardGeom.get(id);
  if (!g) return;
  const panel = $("#sv-panel");
  panel.hidden = false;
  $("#sv-note").textContent = "Finding nearest panorama…";
  try {
    await loadMapsJs();
    const svc = new google.maps.StreetViewService();
    const panoId = billboardProps.get(id)?.sv_pano_id;
    const { data } = await svc.getPanorama(
      panoId
        ? { pano: panoId } // surveyed pano recorded on the billboard
        : {
            location: { lat: g.lat, lng: g.lng },
            radius: SV_RADIUS_M,
            source: google.maps.StreetViewSource.OUTDOOR,
            preference: google.maps.StreetViewPreference.NEAREST,
          }
    );
    const ll = data.location.latLng;
    const from = { lng: ll.lng(), lat: ll.lat() };
    const dist = metresBetween(from, g);
    const heading = bearingDeg(from, g);
    const pitch = Math.min(Cesium.Math.toDegrees(Math.atan2(g.base + g.bh / 2 - SV_CAM_HEIGHT, Math.max(dist, 5))), 70);
    const pov = { heading, pitch };
    if (!panorama) {
      panorama = new google.maps.StreetViewPanorama($("#sv-pano"), {
        pano: data.location.pano,
        pov,
        zoom: dist > 80 ? 1.5 : 1,
        addressControl: false,
        fullscreenControl: false, // our bottom-right controls replace Google's
        zoomControl: false,
        panControl: false,
        motionTracking: false,
        showRoadLabels: false,
      });
      for (const ev of ["pov_changed", "zoom_changed", "pano_changed", "position_changed", "visible_changed"]) {
        panorama.addListener(ev, svUpdateOverlay);
      }
      requestAnimationFrame(() => google.maps.event.trigger(panorama, "resize"));
    } else {
      panorama.setPano(data.location.pano);
      panorama.setPov(pov);
      panorama.setZoom(dist > 80 ? 1.5 : 1);
    }
    svSetBoard(id);
    const when = data.imageDate ? ` · captured ${data.imageDate}` : "";
    const aligned = !!svAlignedCorners();
    $("#sv-note").textContent = `Panorama ${Math.round(dist)} m from board, aimed at it (heading ${Math.round(heading)}°)${when}. ` +
      (aligned ? "Board overlay aligned to this panorama." : "Board overlay is a projection, ±few metres. Align it in the billboard panel.");
  } catch (e) {
    const msg = String(e?.message || e?.code || e);
    $("#sv-note").textContent = /ZERO_RESULTS/.test(msg)
      ? `No Street View within ${SV_RADIUS_M} m of this board.`
      : `Street View unavailable: ${msg}`;
  }
}

// Street View photo of the board, served by the proxy (see /api/billboards/:id/photo).
function streetViewPhotoUrl(id) {
  const p = billboardProps.get(id);
  if (!p) return null;
  const v = JSON.stringify([p.sv_pano_id, p.sv_alignments?.[p.sv_pano_id] ?? null, p.heading_deg]).length;
  return `/api/billboards/${encodeURIComponent(id)}/photo?v=${v}`;
}

function showBillboard(p) {
  const box = $("#billboard-box");
  $("#panel-title").textContent = p?.name || p?.id || "Chennai 3D Live";
  if (!p) { box.hidden = true; return; }
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fields = [
    ["ID", p.id], ["Name", p.name || "—"], ["Type", p.type], ["Owner", p.owner || "—"], ["Permit", p.permit_no || "—"],
    ["Base", p.base_height_m != null ? `${p.base_height_m} m` : "—"],
    ["Board", `${p.width_m ?? "?"} × ${p.board_height_m ?? "?"} m`],
    ["Surveyed", p.surveyed_on || "—"],
  ];
  const sp = billboardSpeed.get(p.id);
  const photo = streetViewPhotoUrl(p.id);
  $("#billboard-content").innerHTML =
    `<dl>${fields.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}` +
    `<dt>Traffic</dt><dd id="speed-cell" data-id="${esc(p.id)}">${sp?.speedKmh ? esc(speedText(sp)) : sp?.error ? `n/a (${esc(sp.error)})` : "loading…"}</dd></dl>` +
    (photo ? `<figure class="bb-photo"><img src="${esc(photo)}" alt="Street View of ${esc(p.id)}" loading="lazy"><figcaption class="muted small">Street View photo of the location</figcaption></figure>` : "") +
    (p.photo_url ? `<p><a href="${esc(p.photo_url)}" target="_blank" rel="noopener">Photo</a></p>` : "") +
    `<p class="small"><a id="bb-manage" class="muted" href="/admin.html?id=${encodeURIComponent(p.id)}">Edit creative &amp; alignment ↗</a></p>`;
  box.hidden = false;
  $("#g-admin").href = `/admin.html?id=${encodeURIComponent(p.id)}`;

  // Street View is the default view: open it for every selected board (skip if already showing it).
  if (p.id && billboardGeom.has(p.id) && (svBoardId !== p.id || $("#sv-panel").hidden)) openStreetView(p.id);

}

// ---------- Scene clicks: pick billboards ----------
const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
handler.setInputAction((click) => {
  const picked = viewer.scene.pick(click.position);
  const ent = picked?.id;
  const bb = ent?.properties?.billboard?.getValue?.();
  showBillboard(bb || null);
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

// ---------- Place search ----------
const searchDs = new Cesium.CustomDataSource("search");
viewer.dataSources.add(searchDs);
const RECENT_KEY = "recentSearches";
const RECENT_MAX = 4;
let searchSession = crypto.randomUUID();
let searchTimer = null;
let searchItems = []; // currently listed items
let searchCursor = -1;

const readRecent = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); } catch { return []; } };
function pushRecent(item) {
  const list = [item, ...readRecent().filter((r) => r.placeId !== item.placeId)].slice(0, RECENT_MAX);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch {}
}

// sections: [{ header, items }]. Items are flattened for keyboard navigation.
function renderSearchList(sections) {
  const ul = $("#search-list");
  const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  searchItems = [];
  searchCursor = -1;
  let html = "";
  for (const sec of sections) {
    if (!sec.items.length) continue;
    html += sec.header ? `<li class="hdr">${esc(sec.header)}</li>` : "";
    for (const it of sec.items) {
      const i = searchItems.push(it) - 1;
      const icon = it.kind === "billboard" ? "\uD83D\uDCCB" : it.kind === "recent" ? "\uD83D\uDD58" : "\uD83D\uDCCD";
      html += `<li role="option" data-i="${i}"><span class="ico">${icon}</span><span class="main">${esc(it.main)}</span><span class="sec">${esc(it.secondary)}</span></li>`;
    }
  }
  ul.innerHTML = html || `<li class="empty">No matches</li>`;
  ul.hidden = false;
  $("#search").setAttribute("aria-expanded", "true");
}

function billboardSearchItems(q = "") {
  const needle = q.toLowerCase();
  const out = [];
  for (const [id, p] of billboardProps) {
    const hay = `${id} ${p.name ?? ""} ${p.owner ?? ""} ${p.type ?? ""} ${p.permit_no ?? ""}`.toLowerCase();
    if (needle && !hay.includes(needle)) continue;
    const sp = billboardSpeed.get(id);
    out.push({
      kind: "billboard", id, main: p.name || id,
      secondary: [p.name ? id : null, p.type, p.owner, `${p.width_m ?? "?"}\u00D7${p.board_height_m ?? "?"} m`, sp?.speedKmh ? `\uD83D\uDE97 ${sp.speedKmh} km/h` : null].filter(Boolean).join(" \u00B7 "),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function showDefaultSearchList() {
  const recent = readRecent().map((r) => ({ ...r, kind: "recent" }));
  renderSearchList([{ header: "Recent", items: recent }, { header: "Billboards", items: billboardSearchItems() }]);
}
function closeSearchList() {
  $("#search-list").hidden = true;
  $("#search").setAttribute("aria-expanded", "false");
  searchItems = [];
  searchCursor = -1;
}

async function searchAutocomplete(q) {
  const boards = billboardSearchItems(q);
  renderSearchList([{ header: "Billboards", items: boards }, { header: "Places", items: [{ kind: "place", main: "Searching\u2026", secondary: "", placeholder: true }] }]);
  try {
    const r = await getJson(`/api/places/autocomplete?q=${encodeURIComponent(q)}&session=${searchSession}`);
    if ($("#search-input").value.trim() !== q) return; // stale
    renderSearchList([{ header: "Billboards", items: boards }, { header: "Places", items: r.suggestions.map((p) => ({ ...p, kind: "place" })) }]);
  } catch (e) {
    renderSearchList([{ header: "Billboards", items: boards }]);
    setStatus(`Search: ${e.message}`, true);
  }
}

async function selectPlace(item) {
  if (!item || item.placeholder) return;
  closeSearchList();
  $("#search-input").value = item.main;
  if (item.kind === "billboard") {
    overviewBillboard(item.id);
    showBillboard(billboardProps.get(item.id));
    const g = billboardGeom.get(item.id);
    if (g) setHudLocation({ name: item.id, address: item.secondary, lat: g.lat, lng: g.lng });
    return;
  }
  let place = item;
  if (item.lat == null || item.lng == null) {
    setStatus(`Looking up ${item.main}…`);
    try {
      place = { ...item, ...(await getJson(`/api/places/${encodeURIComponent(item.placeId)}?session=${searchSession}`)) };
    } catch (e) {
      setStatus(`Place lookup failed: ${e.message}`, true);
      return;
    }
  }
  searchSession = crypto.randomUUID(); // a details call ends the billing session
  pushRecent({ placeId: place.placeId, main: place.main || place.name, secondary: place.secondary || place.address, lat: place.lat, lng: place.lng });
  searchDs.entities.removeAll();
  const [ground] = await clampPoints([{ lng: place.lng, lat: place.lat }], 0);
  searchDs.entities.add({
    position: Cesium.Cartesian3.fromDegrees(place.lng, place.lat, cartoOf(ground).height + 2),
    point: { pixelSize: 12, color: Cesium.Color.fromCssColorString("#ff5252"), outlineColor: Cesium.Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
    label: {
      text: place.main || place.name,
      font: "13px sans-serif",
      fillColor: Cesium.Color.WHITE,
      showBackground: true,
      backgroundColor: Cesium.Color.fromCssColorString("#ff5252").withAlpha(0.85),
      pixelOffset: new Cesium.Cartesian2(0, -18),
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });
  flyTo(place.lng, place.lat, 700, -40);
  setHudLocation({ name: place.main || place.name, address: place.secondary || place.address, lat: place.lat, lng: place.lng });
  setStatus(`${place.main || place.name} · ${place.secondary || place.address || ""}`);
}

const searchInput = $("#search-input");
searchInput.addEventListener("focus", () => {
  if (!searchInput.value.trim()) showDefaultSearchList();
});
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (!q) return showDefaultSearchList();
  if (q.length < 2) return renderSearchList([{ header: "Billboards", items: billboardSearchItems(q) }]);
  searchTimer = setTimeout(() => searchAutocomplete(q), 250);
});
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeSearchList(); searchInput.blur(); return; }
  if (!searchItems.length) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    searchCursor = (searchCursor + (e.key === "ArrowDown" ? 1 : -1) + searchItems.length) % searchItems.length;
    $("#search-list").querySelectorAll("li[role=option]").forEach((li, i) => li.setAttribute("aria-selected", i === searchCursor));
  } else if (e.key === "Enter") {
    e.preventDefault();
    selectPlace(searchItems[searchCursor >= 0 ? searchCursor : 0]);
  }
});
$("#search-list").addEventListener("mousedown", (e) => {
  const li = e.target.closest("li[role=option]");
  if (!li) return;
  e.preventDefault(); // keep focus handling simple
  selectPlace(searchItems[Number(li.dataset.i)]);
});
document.addEventListener("mousedown", (e) => { if (!e.target.closest("#search")) closeSearchList(); });

// ---------- Layout: Street View main vs map main; the other view is a bottom-left thumbnail ----------
function setSvMain(on) {
  document.body.classList.toggle("sv-main", on);
  document.body.classList.toggle("map-main", !on);
  $("#viewer").classList.toggle("inset", on);
  $("#sv-panel").classList.toggle("inset", !on);
  $("#g-peg").classList.toggle("active", on);
  // both renderers must re-measure their containers
  requestAnimationFrame(() => {
    viewer.resize();
    if (panorama && window.google?.maps) google.maps.event.trigger(panorama, "resize");
    svUpdateOverlay();
  });
}
const isSvMain = () => document.body.classList.contains("sv-main");
const swapViews = () => setSvMain(!isSvMain());
for (const id of ["#map-cap", "#sv-cap", "#g-peg"]) {
  $(id).addEventListener("click", swapViews);
  $(id).addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); swapViews(); } });
}
// Street View is always the main view on load; swapping lasts for the session only.
try { localStorage.removeItem("svMain"); } catch {}
setSvMain(true);

// Google Maps style controls: locate, zoom, view tiles.
$("#g-locate").addEventListener("click", () => {
  const id = svBoardId; const g = id && billboardGeom.get(id);
  if (!g) return;
  if (isSvMain() && panorama) {
    const pos = panorama.getPosition();
    if (!pos) return;
    const from = { lng: pos.lng(), lat: pos.lat() };
    const dist = metresBetween(from, g);
    const pitch = Math.min(Cesium.Math.toDegrees(Math.atan2(g.base + g.bh / 2 - SV_CAM_HEIGHT, Math.max(dist, 5))), 70);
    panorama.setPov({ heading: bearingDeg(from, g), pitch });
    panorama.setZoom(dist > 80 ? 1.5 : 1);
  } else overviewBillboard(id);
});
function zoomBy(dir) {
  if (isSvMain() && panorama) {
    panorama.setZoom(Math.max(0, Math.min(4, (panorama.getZoom() ?? 1) + 0.5 * dir)));
  } else {
    const h = viewer.camera.positionCartographic?.height ?? 500;
    const step = Math.max(15, Math.abs(h) * 0.35);
    if (dir > 0) viewer.camera.zoomIn(step); else viewer.camera.zoomOut(step);
  }
}
$("#g-zoom-in").addEventListener("click", () => zoomBy(1));
$("#g-zoom-out").addEventListener("click", () => zoomBy(-1));
$("#g-bar").addEventListener("click", (e) => {
  const tile = e.target.closest(".g-tile[data-view]");
  if (!tile || !svBoardId) return;
  const id = svBoardId;
  if (isSvMain()) setSvMain(false); // these are 3D map views
  switch (tile.dataset.view) {
    case "driver": driverView(id); break;
    case "drive": driverView(id, { animate: true }); break;
    case "flip": driverView(id, { flipped: !driverState.flipped }); break;
    case "overview": overviewBillboard(id); break;
  }
});
function setBarCollapsed(c) {
  $("#g-bar").classList.toggle("collapsed", c);
  $("#g-collapse").setAttribute("aria-expanded", String(!c));
  $("#g-collapse").title = c ? "Expand" : "Collapse";
  try { localStorage.setItem("gBarCollapsed", c ? "1" : "0"); } catch {}
}
$("#g-collapse").addEventListener("click", () => setBarCollapsed(!$("#g-bar").classList.contains("collapsed")));
// Phones start with the tile bar collapsed (more map room). A saved choice always wins.
try { setBarCollapsed((localStorage.getItem("gBarCollapsed") ?? (IS_MOBILE ? "1" : "0")) === "1"); } catch {}

// ---------- UI wiring ----------
const panelToggle = $("#panel-toggle");
function setPanelCollapsed(collapsed) {
  $("#panel").classList.toggle("collapsed", collapsed);
  document.body.classList.toggle("panel-open", !collapsed); // lifts the map controls above the phone sheet
  panelToggle.setAttribute("aria-expanded", String(!collapsed));
  panelToggle.textContent = collapsed ? "+" : "\u2212";
  panelToggle.title = collapsed ? "Show panel" : "Hide panel";
  try { localStorage.setItem("panelCollapsed", collapsed ? "1" : "0"); } catch {}
}
panelToggle.addEventListener("click", () => setPanelCollapsed(!$("#panel").classList.contains("collapsed")));
// Phones start with the sheet collapsed to its header; a saved choice always wins.
try { setPanelCollapsed((localStorage.getItem("panelCollapsed") ?? (IS_MOBILE ? "1" : "0")) === "1"); } catch {}


// Admin panel (admin.html) bumps this key after saving a creative or alignment; re-read the records.
window.addEventListener("storage", (e) => {
  if (e.key === "billboardsUpdated" && svBoardId) reloadBillboards(svBoardId).catch((err) => setStatus(`Reload failed: ${err.message}`, true));
});

// ---------- Boot ----------
flyTo(CHENNAI.lng, CHENNAI.lat, 1500);
await loadTiles();
// Load sequentially so small layers and the view get tiles first. Weather needs no tiles.
// Traffic corridors layer exists but is off by default: setLayer("traffic", true) to enable.
setLayer("weather", true);
await setLayer("billboards", true);
// Off by default: "air" markers (AQI lives in the right-hand widget), "metro-blue" (stations/track), "traffic".
