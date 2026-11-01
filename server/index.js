import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import * as store from "./store.js";
import { CORRIDORS, AIR_POINTS, WEATHER_POINT, CACHE_TTL } from "./config.js";
import * as M from "../public/sv-math.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const SERVER_KEY = process.env.GOOGLE_SERVER_KEY || "";
const BROWSER_KEY = process.env.GOOGLE_BROWSER_KEY || "";
const PORT = Number(process.env.PORT) || 3000;

if (!SERVER_KEY) console.warn("[warn] GOOGLE_SERVER_KEY not set: /api/traffic, /api/air, /api/weather will fail.");
if (!BROWSER_KEY) console.warn("[warn] GOOGLE_BROWSER_KEY not set: 3D tiles will not load in the browser.");

// ---------- tiny TTL cache ----------
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await fn();
  cache.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}

async function googleJson(url, init = {}) {
  const r = await fetch(url, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = body?.error?.message || `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return body;
}

const seconds = (s) => (typeof s === "string" ? parseInt(s, 10) : Number(s)) || 0;

// ---------- Google API calls ----------
async function fetchCorridor(c) {
  const body = await googleJson("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": SERVER_KEY,
      "X-Goog-FieldMask":
        "routes.duration,routes.staticDuration,routes.distanceMeters,routes.polyline.encodedPolyline",
    },
    body: JSON.stringify({
      origin: { location: { latLng: c.origin } },
      destination: { location: { latLng: c.destination } },
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_AWARE",
      polylineQuality: "HIGH_QUALITY",
    }),
  });
  const r = body.routes?.[0];
  if (!r) throw new Error("no route");
  const duration = seconds(r.duration);
  const staticDuration = seconds(r.staticDuration) || duration;
  return {
    id: c.id,
    name: c.name,
    duration,
    staticDuration,
    ratio: staticDuration ? duration / staticDuration : 1,
    distanceMeters: r.distanceMeters ?? null,
    polyline: r.polyline?.encodedPolyline ?? "",
  };
}

async function fetchAir(p) {
  const body = await googleJson(
    `https://airquality.googleapis.com/v1/currentConditions:lookup?key=${encodeURIComponent(SERVER_KEY)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location: { latitude: p.latitude, longitude: p.longitude },
        universalAqi: true,
        extraComputations: ["DOMINANT_POLLUTANT_CONCENTRATION", "LOCAL_AQI"],
      }),
    }
  );
  const idx = body.indexes?.find((i) => i.code === "uaqi") || body.indexes?.[0] || {};
  const local = body.indexes?.find((i) => i.code !== "uaqi");
  return {
    name: p.name,
    latitude: p.latitude,
    longitude: p.longitude,
    aqi: idx.aqi ?? null,
    category: idx.category ?? null,
    dominantPollutant: idx.dominantPollutant ?? null,
    color: idx.color ?? null, // {red,green,blue} 0..1
    localAqi: local ? { code: local.code, aqi: local.aqi, category: local.category } : null,
    dateTime: body.dateTime ?? null,
  };
}

async function fetchWeather(p) {
  const q = new URLSearchParams({
    key: SERVER_KEY,
    "location.latitude": String(p.latitude),
    "location.longitude": String(p.longitude),
    unitsSystem: "METRIC",
  });
  const b = await googleJson(`https://weather.googleapis.com/v1/currentConditions:lookup?${q}`);
  return {
    name: p.name,
    latitude: p.latitude,
    longitude: p.longitude,
    time: b.currentTime ?? null,
    condition: b.weatherCondition?.description?.text ?? null,
    conditionType: b.weatherCondition?.type ?? null,
    iconBaseUri: b.weatherCondition?.iconBaseUri ?? null,
    temperatureC: b.temperature?.degrees ?? null,
    feelsLikeC: b.feelsLikeTemperature?.degrees ?? null,
    humidityPct: b.relativeHumidity ?? null,
    windKmh: b.wind?.speed?.value ?? null,
    windDir: b.wind?.direction?.cardinal ?? null,
    precipProbabilityPct: b.precipitation?.probability?.percent ?? null,
    uvIndex: b.uvIndex ?? null,
    isDaytime: b.isDaytime ?? null,
  };
}

// ---------- app ----------
const app = express();
app.disable("x-powered-by");

// Public, referrer-restricted browser key only. Never expose SERVER_KEY here.
app.get("/config.js", (_req, res) => {
  res.type("application/javascript");
  res.send(`window.APP_CONFIG = ${JSON.stringify({ googleBrowserKey: BROWSER_KEY })};`);
});

app.get("/api/traffic", async (_req, res) => {
  try {
    const data = await cached("traffic", CACHE_TTL.traffic, async () => {
      const results = await Promise.allSettled(CORRIDORS.map(fetchCorridor));
      if (results.every((r) => r.status === "rejected")) throw results[0].reason;
      return {
        fetchedAt: new Date().toISOString(),
        routes: results.map((r, i) =>
          r.status === "fulfilled" ? r.value : { id: CORRIDORS[i].id, name: CORRIDORS[i].name, error: r.reason?.message }
        ),
      };
    });
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/air", async (_req, res) => {
  try {
    const data = await cached("air", CACHE_TTL.air, async () => {
      const results = await Promise.allSettled(AIR_POINTS.map(fetchAir));
      if (results.every((r) => r.status === "rejected")) throw results[0].reason;
      return {
        fetchedAt: new Date().toISOString(),
        points: results.map((r, i) =>
          r.status === "fulfilled" ? r.value : { ...AIR_POINTS[i], error: r.reason?.message }
        ),
      };
    });
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

function pointFromQuery(q, fallback) {
  const lat = Number(q.lat), lng = Number(q.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    // round to ~100 m so nearby requests share a cache entry
    return { name: String(q.name || "").slice(0, 80) || "Location", latitude: +lat.toFixed(3), longitude: +lng.toFixed(3) };
  }
  return fallback;
}

app.get("/api/weather", async (req, res) => {
  try {
    const pt = pointFromQuery(req.query, WEATHER_POINT);
    const data = await cached(`weather:${pt.latitude},${pt.longitude}`, CACHE_TTL.weather, () => fetchWeather(pt));
    res.json({ fetchedAt: new Date().toISOString(), ...data, name: pt.name });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/air/point", async (req, res) => {
  try {
    const pt = pointFromQuery(req.query, WEATHER_POINT);
    const data = await cached(`air:${pt.latitude},${pt.longitude}`, CACHE_TTL.air, () => fetchAir(pt));
    res.json({ fetchedAt: new Date().toISOString(), ...data, name: pt.name });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Own billboard dataset (GeoJSON). Not derived from Google content.

app.get("/api/billboards", async (_req, res) => {
  try {
    res.set("Cache-Control", "no-store").type("application/geo+json").send(JSON.stringify(await store.loadBillboards(), null, 2));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Creative images for billboards: stored in Neon (or data/creatives locally), URL saved on the feature.
const IMAGE_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const loadBillboards = store.loadBillboards;
const saveBillboards = store.saveBillboards;
function findFeature(geo, id) {
  return geo.features.find((f) => f.properties?.id === id);
}
async function removeCreativeFile(url) {
  if (!url) return;
  const name = path.basename(url.split("?")[0]);
  await store.deleteCreative(name);
}

app.put(
  "/api/billboards/:id/creative",
  express.raw({ type: Object.keys(IMAGE_EXT), limit: "10mb" }),
  async (req, res) => {
    try {
      const { id } = req.params;
      const ext = IMAGE_EXT[req.get("content-type")?.split(";")[0]];
      if (!ID_RE.test(id)) return res.status(400).json({ error: "bad id" });
      if (!ext) return res.status(415).json({ error: "png, jpeg, webp or gif only" });
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: "empty body" });
      const geo = await loadBillboards();
      const f = findFeature(geo, id);
      if (!f) return res.status(404).json({ error: "unknown billboard" });
      await removeCreativeFile(f.properties.creative_url);
      const name = `${id}.${ext}`;
      await store.putCreative(name, req.get("content-type").split(";")[0], req.body);
      f.properties.creative_url = `/creatives/${name}?v=${Date.now()}`;
      await saveBillboards(geo);
      res.json({ id, creative_url: f.properties.creative_url });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

// Live average traffic speed on the road in front of a billboard.
// Samples a short segment (±SPEED_HALF_M along the road, which runs perpendicular to the board's
// facing direction) in both directions with the Routes API and reports the live vs free-flow speed.
const SPEED_HALF_M = 250;
const SPEED_FRONT_M = 15;

function offsetLatLng(lat, lng, bearingDeg, meters) {
  const R = 6378137;
  const b = (bearingDeg * Math.PI) / 180;
  const dLat = (meters * Math.cos(b)) / R;
  const dLng = (meters * Math.sin(b)) / (R * Math.cos((lat * Math.PI) / 180));
  return { latitude: lat + (dLat * 180) / Math.PI, longitude: lng + (dLng * 180) / Math.PI };
}

async function routeSpeed(a, b) {
  const body = await googleJson("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": SERVER_KEY,
      "X-Goog-FieldMask": "routes.duration,routes.staticDuration,routes.distanceMeters,routes.polyline.encodedPolyline",
    },
    body: JSON.stringify({
      origin: { location: { latLng: a } },
      destination: { location: { latLng: b } },
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_AWARE_OPTIMAL",
      polylineQuality: "HIGH_QUALITY",
    }),
  });
  const r = body.routes?.[0];
  if (!r) throw new Error("no route");
  const dist = r.distanceMeters || 0;
  const dur = seconds(r.duration);
  const sdur = seconds(r.staticDuration) || dur;
  if (!dist || !dur) throw new Error("empty route");
  return {
    distanceMeters: dist,
    durationS: dur,
    speedKmh: (dist / dur) * 3.6,
    freeFlowKmh: (dist / sdur) * 3.6,
    polyline: r.polyline?.encodedPolyline ?? "",
  };
}

app.get("/api/billboards/:id/speed", async (req, res) => {
  try {
    const { id } = req.params;
    if (!ID_RE.test(id)) return res.status(400).json({ error: "bad id" });
    const data = await cached(`speed:${id}`, CACHE_TTL.traffic, async () => {
      const geo = await loadBillboards();
      const f = findFeature(geo, id);
      if (!f) throw Object.assign(new Error("unknown billboard"), { status: 404 });
      const [lng, lat] = f.geometry.coordinates;
      const heading = Number(f.properties.heading_deg) || 0;
      const front = offsetLatLng(lat, lng, heading, SPEED_FRONT_M);
      const a = offsetLatLng(front.latitude, front.longitude, heading + 90, SPEED_HALF_M);
      const b = offsetLatLng(front.latitude, front.longitude, heading - 90, SPEED_HALF_M);
      const results = await Promise.allSettled([routeSpeed(a, b), routeSpeed(b, a)]);
      const ok = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
      if (!ok.length) throw results[0].reason;
      // Prefer the direction with the least detour; also report the mean of both.
      const best = ok.reduce((m, r) => (r.distanceMeters < m.distanceMeters ? r : m));
      const mean = (k) => ok.reduce((s, r) => s + r[k], 0) / ok.length;
      return {
        id,
        sampledAt: new Date().toISOString(),
        speedKmh: Math.round(best.speedKmh),
        freeFlowKmh: Math.round(best.freeFlowKmh),
        meanSpeedKmh: Math.round(mean("speedKmh")),
        segmentMeters: best.distanceMeters,
        directions: ok.length,
        // Road geometry past the board, one entry per direction, for the driver view.
        polylines: ok.map((r) => r.polyline),
      };
    });
    res.json(data);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

// Street View alignment: per-pano corners {heading,pitch}° (TL,TR,BR,BL), optional fitted geometry.
app.put("/api/billboards/:id/streetview", express.json({ limit: "16kb" }), async (req, res) => {
  try {
    const { id } = req.params;
    if (!ID_RE.test(id)) return res.status(400).json({ error: "bad id" });
    const { pano_id, corners, set_default, geometry, pano_lat, pano_lng } = req.body || {};
    if (!/^[A-Za-z0-9_.-]{5,128}$/.test(pano_id || "")) return res.status(400).json({ error: "bad pano id" }); // Street View pano ids can contain "."
    const okCorners =
      corners == null ||
      (Array.isArray(corners) && corners.length === 4 &&
        corners.every((c) => Number.isFinite(c?.heading) && Number.isFinite(c?.pitch) && Math.abs(c.pitch) <= 90));
    if (!okCorners) return res.status(400).json({ error: "corners must be 4 {heading,pitch}" });
    const geo = await loadBillboards();
    const f = findFeature(geo, id);
    if (!f) return res.status(404).json({ error: "unknown billboard" });
    const P = f.properties;
    // migrate legacy single alignment
    if (P.sv_corners && P.sv_pano_id) { P.sv_alignments = { ...(P.sv_alignments || {}), [P.sv_pano_id]: P.sv_corners }; delete P.sv_corners; }
    P.sv_alignments = P.sv_alignments || {};
    if (corners == null) delete P.sv_alignments[pano_id];
    else {
      const entry = { corners: corners.map((c) => ({ heading: +c.heading.toFixed(3), pitch: +c.pitch.toFixed(3) })) };
      if (Number.isFinite(Number(pano_lat)) && Number.isFinite(Number(pano_lng))) { entry.lat = +Number(pano_lat).toFixed(7); entry.lng = +Number(pano_lng).toFixed(7); }
      P.sv_alignments[pano_id] = entry;
    }
    if (set_default || !P.sv_pano_id) P.sv_pano_id = pano_id;
    if (geometry) {
      const num = (k, lo, hi) => { const v = Number(geometry[k]); return Number.isFinite(v) && v >= lo && v <= hi ? v : null; };
      const lat = num("lat", -90, 90), lng = num("lng", -180, 180);
      if (lat != null && lng != null) f.geometry.coordinates = [+lng.toFixed(6), +lat.toFixed(6)];
      for (const [k, lo, hi] of [["base_height_m", 0, 200], ["board_height_m", 0.2, 50], ["width_m", 0.2, 100], ["heading_deg", 0, 360]]) {
        const v = num(k, lo, hi); if (v != null) P[k] = +v.toFixed(1);
      }
      P.geometry_source = `fitted from Street View alignment on pano ${pano_id} (${new Date().toISOString().slice(0, 10)})`;
    }
    await saveBillboards(geo);
    res.json({ id, properties: P, coordinates: f.geometry.coordinates });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- AI auto-align ----------
// Fetch one Street View Static view of the pano, ask a vision model for the board face's four corners in
// image pixels, then convert them to absolute {heading, pitch} with the same camera model the admin uses.
// Nothing is saved here: the admin prefills the handles and the user saves. Imagery is not kept (only the angles are cached).
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const AUTO_MODEL = process.env.AUTO_ALIGN_MODEL || "claude-opus-5-5";
const AUTO_W = 640, AUTO_H = 400, AUTO_FOV_MAX = 120;
const autoCache = new Map(); // key → { value, expires }

app.post("/api/billboards/:id/auto-align", express.json({ limit: "4kb" }), async (req, res) => {
  try {
    if (!ANTHROPIC_KEY) return res.status(503).json({ error: "ANTHROPIC_API_KEY is not set on the server" });
    if (!SERVER_KEY) return res.status(503).json({ error: "GOOGLE_SERVER_KEY is not set on the server" });
    const { id } = req.params;
    if (!ID_RE.test(id)) return res.status(400).json({ error: "bad id" });
    const { pano_id, heading, pitch, zoom } = req.body || {};
    if (!/^[A-Za-z0-9_.-]{5,128}$/.test(pano_id || "")) return res.status(400).json({ error: "bad pano id" }); // Street View pano ids can contain "."
    const h = Number(heading), p = Number(pitch), z = Number(zoom ?? 1);
    if (!Number.isFinite(h) || !Number.isFinite(p) || Math.abs(p) > 90 || !Number.isFinite(z)) return res.status(400).json({ error: "bad pov" });

    const geo = await loadBillboards();
    const f = findFeature(geo, id);
    if (!f) return res.status(404).json({ error: "unknown billboard" });
    const g = M.geomFromFeature(f);

    // Static view uses the same horizontal field of view as the viewer, capped at the API maximum.
    const hfov = Math.min(AUTO_FOV_MAX, Math.max(10, 180 / Math.pow(2, z)));
    const cam = { heading: ((h % 360) + 360) % 360, pitch: p };
    const cacheKey = [id, pano_id, cam.heading.toFixed(1), cam.pitch.toFixed(1), hfov.toFixed(0)].join("|");
    const hit = autoCache.get(cacheKey);
    if (hit && hit.expires > Date.now()) return res.json(hit.value);

    const q = new URLSearchParams({
      size: `${AUTO_W}x${AUTO_H}`, source: "outdoor", pano: pano_id,
      heading: cam.heading.toFixed(1), pitch: cam.pitch.toFixed(1), fov: hfov.toFixed(0), key: SERVER_KEY,
    });
    const img = await fetch(`https://maps.googleapis.com/maps/api/streetview?${q}`);
    if (!img.ok) return res.status(502).json({ error: `Street View Static: HTTP ${img.status}` });
    const ctype = (img.headers.get("content-type") || "").split(";")[0];
    const mediaType = ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(ctype) ? ctype : "image/jpeg";
    const data = Buffer.from(await img.arrayBuffer()).toString("base64");

    const prompt = `This is a Street View photo, ${AUTO_W}×${AUTO_H} px. Find the outdoor advertising billboard face in it.
Expected board: ${g.bw} m wide × ${g.bh} m tall (width:height ≈ ${(g.bw / g.bh).toFixed(2)}). Ignore other signs, and ignore the frame, poles and supports.
Return ONLY JSON: {"visible": true|false, "corners": [[x,y],[x,y],[x,y],[x,y]], "confidence": 0..1}
corners are pixel coordinates of the face's four outer corners, in this order: top-left, top-right, bottom-right, bottom-left.
If no billboard face is visible, return {"visible": false, "corners": null, "confidence": 0}.`;
    const ar = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: AUTO_MODEL, max_tokens: 300,
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data } },
          { type: "text", text: prompt },
        ] }],
      }),
    });
    const body = await ar.json().catch(() => ({}));
    if (!ar.ok) return res.status(502).json({ error: `Vision API: ${body?.error?.message || ar.status}` });
    const text = (body.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
    let out;
    try { out = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? ""); } catch { return res.status(502).json({ error: "Vision API returned no parsable JSON" }); }

    const noFace = "No billboard face found in this view. Try another panorama, or align by hand.";
    if (!out.visible || !Array.isArray(out.corners) || out.corners.length !== 4) return res.status(422).json({ error: noFace });
    const raw = out.corners.map(([x, y]) => [Number(x), Number(y)]);
    if (raw.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) return res.status(422).json({ error: noFace });

    const warnings = [];
    const pts = raw.map(([x, y]) => [Math.min(AUTO_W, Math.max(0, x)), Math.min(AUTO_H, Math.max(0, y))]);
    if (pts.some((pt, i) => pt[0] !== raw[i][0] || pt[1] !== raw[i][1])) warnings.push("Some corners were outside the photo and were clamped.");
    // Shoelace: positive for TL→TR→BR→BL on screen (y down). Negative means the order is wrong or the shape folds.
    let twice = 0;
    for (let i = 0; i < 4; i++) { const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % 4]; twice += x1 * y2 - x2 * y1; }
    if (twice <= 0) return res.status(422).json({ error: "Detected corners are in the wrong order or folded. Align by hand." });
    if (twice / 2 < 0.005 * AUTO_W * AUTO_H) return res.status(422).json({ error: "Detected board is too small in this view. Zoom in or pick a closer panorama." });
    // Rough proportion check (perspective skews it, so this only warns).
    const len = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
    const wPx = (len(pts[0], pts[1]) + len(pts[3], pts[2])) / 2, hPx = (len(pts[0], pts[3]) + len(pts[1], pts[2])) / 2;
    const expected = g.bw / g.bh;
    if (hPx > 0 && Math.abs((wPx / hPx) / expected - 1) > 0.6) warnings.push("Shape proportions differ from the board's size. Check the corners.");

    // Pixel → absolute angles with the static view's own camera (same model as the admin overlay).
    const c = M.svCamera(cam, Math.log2(180 / hfov), AUTO_W, AUTO_H);
    const corners = pts.map(([x, y]) => {
      const a = M.svUnproject(c, x, y);
      return { heading: +a.heading.toFixed(3), pitch: +a.pitch.toFixed(3) };
    });
    const confidence = Number.isFinite(Number(out.confidence)) ? Math.max(0, Math.min(1, Number(out.confidence))) : null;
    const value = { corners, confidence, warnings, model: AUTO_MODEL };
    autoCache.set(cacheKey, { value, expires: Date.now() + 60 * 60 * 1000 });
    res.json(value);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Street View Static photo of the board: from its aligned pano aimed at the board, else nearest pano.
const photoCache = new Map(); // key → { buf, type, expires }
app.get("/api/billboards/:id/photo", async (req, res) => {
  try {
    const { id } = req.params;
    if (!ID_RE.test(id)) return res.status(400).json({ error: "bad id" });
    const geo = await loadBillboards();
    const f = findFeature(geo, id);
    if (!f) return res.status(404).json({ error: "unknown billboard" });
    const P = f.properties;
    const [lng, lat] = f.geometry.coordinates;
    const q = new URLSearchParams({ size: "640x400", source: "outdoor", return_error_code: "true", key: SERVER_KEY });
    const align = P.sv_pano_id && P.sv_alignments?.[P.sv_pano_id];
    const corners = align ? (Array.isArray(align) ? align : align.corners) : null;
    if (P.sv_pano_id) q.set("pano", P.sv_pano_id); else q.set("location", `${lat},${lng}`);
    if (corners) {
      const hs = corners.map((c) => c.heading), ps = corners.map((c) => c.pitch);
      const rel = hs.map((h) => ((h - hs[0] + 540) % 360) - 180);
      const heading = (hs[0] + rel.reduce((a, b) => a + b, 0) / 4 + 360) % 360;
      const pitch = ps.reduce((a, b) => a + b, 0) / 4;
      const span = Math.max(Math.max(...rel) - Math.min(...rel), Math.max(...ps) - Math.min(...ps));
      q.set("heading", heading.toFixed(1));
      q.set("pitch", Math.max(-10, Math.min(45, pitch - span * 0.3)).toFixed(1));
      q.set("fov", Math.max(30, Math.min(90, span * 3.5)).toFixed(0));
    } else if (align && Number.isFinite(align.lat)) {
      const dLng = ((lng - align.lng) * Math.PI) / 180, la1 = (align.lat * Math.PI) / 180, la2 = (lat * Math.PI) / 180;
      const brg = (Math.atan2(Math.sin(dLng) * Math.cos(la2), Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng)) * 180) / Math.PI;
      q.set("heading", ((brg + 360) % 360).toFixed(1)); q.set("pitch", "10"); q.set("fov", "70");
    } else {
      q.set("heading", (((Number(P.heading_deg) || 0) + 180) % 360).toFixed(0)); q.set("pitch", "10"); q.set("fov", "80");
    }
    const key = q.toString();
    const hit = photoCache.get(key);
    if (hit && hit.expires > Date.now()) { res.type(hit.type).set("Cache-Control", "private, max-age=3600").send(hit.buf); return; }
    const r = await fetch(`https://maps.googleapis.com/maps/api/streetview?${key}`);
    if (!r.ok) return res.status(r.status).json({ error: `Street View Static: HTTP ${r.status} ${(await r.text()).slice(0, 200)}` });
    const buf = Buffer.from(await r.arrayBuffer());
    const type = r.headers.get("content-type") || "image/jpeg";
    photoCache.set(key, { buf, type, expires: Date.now() + 6 * 60 * 60 * 1000 });
    res.type(type).set("Cache-Control", "private, max-age=3600").send(buf);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.delete("/api/billboards/:id/creative", async (req, res) => {
  try {
    const { id } = req.params;
    if (!ID_RE.test(id)) return res.status(400).json({ error: "bad id" });
    const geo = await loadBillboards();
    const f = findFeature(geo, id);
    if (!f) return res.status(404).json({ error: "unknown billboard" });
    await removeCreativeFile(f.properties.creative_url);
    delete f.properties.creative_url;
    await saveBillboards(geo);
    res.json({ id, creative_url: null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/creatives/:name", async (req, res) => {
  try {
    if (!/^[A-Za-z0-9_-]{1,64}\.(png|jpg|webp|gif)$/.test(req.params.name)) return res.status(404).end();
    const c = await store.getCreative(req.params.name);
    if (!c) return res.status(404).end();
    res.set("Cache-Control", "public, max-age=31536000, immutable").type(c.type).send(c.buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Place search (Places API New) proxied so the server key stays private.
const CHENNAI = { latitude: 13.0827, longitude: 80.2707 };

app.get("/api/places/autocomplete", async (req, res) => {
  try {
    const input = String(req.query.q || "").trim();
    if (input.length < 2) return res.json({ suggestions: [] });
    const body = await googleJson("https://places.googleapis.com/v1/places:autocomplete", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": SERVER_KEY },
      body: JSON.stringify({
        input,
        sessionToken: req.query.session || undefined,
        locationRestriction: { rectangle: { low: { latitude: 12.70, longitude: 79.90 }, high: { latitude: 13.40, longitude: 80.45 } } },
        includedRegionCodes: ["in"],
        languageCode: "en",
      }),
    });
    res.json({
      suggestions: (body.suggestions || [])
        .map((s) => s.placePrediction)
        .filter(Boolean)
        .slice(0, 6)
        .map((p) => ({
          placeId: p.placeId,
          main: p.structuredFormat?.mainText?.text || p.text?.text || "",
          secondary: p.structuredFormat?.secondaryText?.text || "",
        })),
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/places/:placeId", async (req, res) => {
  try {
    const id = req.params.placeId;
    if (!/^[A-Za-z0-9_-]{5,300}$/.test(id)) return res.status(400).json({ error: "bad place id" });
    const q = req.query.session ? `?sessionToken=${encodeURIComponent(req.query.session)}` : "";
    const b = await googleJson(`https://places.googleapis.com/v1/places/${id}${q}`, {
      headers: { "X-Goog-Api-Key": SERVER_KEY, "X-Goog-FieldMask": "id,displayName,formattedAddress,location" },
    });
    res.json({
      placeId: b.id,
      name: b.displayName?.text || "",
      address: b.formattedAddress || "",
      lat: b.location?.latitude,
      lng: b.location?.longitude,
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Chennai Metro Blue Line: track + stations from OpenStreetMap (ODbL).
app.get("/api/metro/blue", async (_req, res) => {
  try {
    const txt = await readFile(path.join(ROOT, "data", "metro-blue-line.geojson"), "utf8");
    res.type("application/geo+json").send(txt);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.use(express.static(path.join(ROOT, "public")));

// On Vercel the app is served by api/index.js; only listen when run directly.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Chennai 3D live → http://localhost:${PORT}`);
  });
}

export default app;
