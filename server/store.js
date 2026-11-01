// Billboard + creative storage. Neon Postgres when DATABASE_URL is set, otherwise local files in data/.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, unlink, mkdir, copyFile, readdir } from "node:fs/promises";
import * as config from "./config.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BILLBOARDS_FILE = path.join(ROOT, "data", "billboards.geojson");
const CREATIVES_DIR = path.join(ROOT, "data", "creatives");
const MIME = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

export const usingDb = !!process.env.DATABASE_URL;

const LAYERS = ["metro-blue-line"];
const defaultSettings = () => ({
  corridors: config.CORRIDORS,
  air_points: config.AIR_POINTS,
  weather_point: config.WEATHER_POINT,
  cache_ttl: config.CACHE_TTL,
});

// ---------- Postgres (Neon) ----------
let sql = null;
let ready = null;

async function getSql() {
  if (!sql) {
    const { neon } = await import("@neondatabase/serverless");
    sql = neon(process.env.DATABASE_URL);
  }
  return sql;
}

// Create tables once, and seed them from data/ the first time (empty table).
function ensureSchema() {
  ready ??= (async () => {
    const q = await getSql();
    await q`CREATE TABLE IF NOT EXISTS billboards (
      id text PRIMARY KEY,
      position int NOT NULL DEFAULT 0,
      feature jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
    await q`CREATE TABLE IF NOT EXISTS creatives (
      name text PRIMARY KEY,
      content_type text NOT NULL,
      data_b64 text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
    await q`CREATE TABLE IF NOT EXISTS settings (
      key text PRIMARY KEY,
      value jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
    await q`CREATE TABLE IF NOT EXISTS layers (
      name text PRIMARY KEY,
      geojson jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
    // seed settings and layers independently (each only when its row is missing)
    for (const [key, value] of Object.entries(defaultSettings())) {
      await q`INSERT INTO settings (key, value) VALUES (${key}, ${JSON.stringify(value)}::jsonb) ON CONFLICT (key) DO NOTHING`;
    }
    for (const name of LAYERS) {
      const txt = await readFile(path.join(ROOT, "data", `${name}.geojson`), "utf8").catch(() => null);
      if (txt) await q`INSERT INTO layers (name, geojson) VALUES (${name}, ${txt}::jsonb) ON CONFLICT (name) DO NOTHING`;
    }
    const [{ n }] = await q`SELECT count(*)::int AS n FROM billboards`;
    if (n === 0) {
      const geo = JSON.parse(await readFile(BILLBOARDS_FILE, "utf8"));
      for (const [i, f] of geo.features.entries()) {
        await q`INSERT INTO billboards (id, position, feature) VALUES (${f.properties.id}, ${i}, ${JSON.stringify(f)}::jsonb) ON CONFLICT (id) DO NOTHING`;
      }
      const files = await readdir(CREATIVES_DIR).catch(() => []);
      for (const name of files) {
        const ext = name.split(".").pop().toLowerCase();
        if (!MIME[ext]) continue;
        const b64 = (await readFile(path.join(CREATIVES_DIR, name))).toString("base64");
        await q`INSERT INTO creatives (name, content_type, data_b64) VALUES (${name}, ${MIME[ext]}, ${b64}) ON CONFLICT (name) DO NOTHING`;
      }
      console.log(`[db] seeded ${geo.features.length} billboards from data/`);
    }
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

// ---------- API used by server/index.js ----------
export async function loadBillboards() {
  if (!usingDb) return JSON.parse(await readFile(BILLBOARDS_FILE, "utf8"));
  await ensureSchema();
  const q = await getSql();
  const rows = await q`SELECT feature FROM billboards ORDER BY position, id`;
  return { type: "FeatureCollection", name: "chennai_billboards", features: rows.map((r) => r.feature) };
}

export async function saveBillboards(geo) {
  if (!usingDb) {
    // keep the previous version next to the file so an accidental edit can be undone by hand
    await copyFile(BILLBOARDS_FILE, `${BILLBOARDS_FILE}.bak`).catch(() => {});
    await writeFile(BILLBOARDS_FILE, JSON.stringify(geo, null, 2) + "\n");
    return;
  }
  await ensureSchema();
  const q = await getSql();
  await q.transaction(
    geo.features.map(
      (f, i) => q`INSERT INTO billboards (id, position, feature) VALUES (${f.properties.id}, ${i}, ${JSON.stringify(f)}::jsonb)
        ON CONFLICT (id) DO UPDATE SET position = EXCLUDED.position, feature = EXCLUDED.feature, updated_at = now()`
    )
  );
}

export async function putCreative(name, contentType, buf) {
  if (!usingDb) {
    await mkdir(CREATIVES_DIR, { recursive: true });
    await writeFile(path.join(CREATIVES_DIR, name), buf);
    return;
  }
  await ensureSchema();
  const q = await getSql();
  const b64 = buf.toString("base64");
  await q`INSERT INTO creatives (name, content_type, data_b64) VALUES (${name}, ${contentType}, ${b64})
    ON CONFLICT (name) DO UPDATE SET content_type = EXCLUDED.content_type, data_b64 = EXCLUDED.data_b64, updated_at = now()`;
}

export async function getCreative(name) {
  if (!usingDb) {
    const ext = name.split(".").pop().toLowerCase();
    const buf = await readFile(path.join(CREATIVES_DIR, name)).catch(() => null);
    return buf ? { type: MIME[ext] || "application/octet-stream", buf } : null;
  }
  await ensureSchema();
  const q = await getSql();
  const [r] = await q`SELECT content_type, data_b64 FROM creatives WHERE name = ${name}`;
  return r ? { type: r.content_type, buf: Buffer.from(r.data_b64, "base64") } : null;
}

export async function deleteCreative(name) {
  if (!usingDb) return void (await unlink(path.join(CREATIVES_DIR, name)).catch(() => {}));
  await ensureSchema();
  const q = await getSql();
  await q`DELETE FROM creatives WHERE name = ${name}`;
}

// ---------- settings (corridors, air points, weather point, cache TTLs) ----------
// Stored in Neon so they can be changed without a deploy; server/config.js is the seed and the no-DB fallback.
let settingsCache = null;
export async function getSettings() {
  if (!usingDb) return defaultSettings();
  if (settingsCache && settingsCache.expires > Date.now()) return settingsCache.value;
  await ensureSchema();
  const q = await getSql();
  const rows = await q`SELECT key, value FROM settings`;
  const value = { ...defaultSettings(), ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
  settingsCache = { value, expires: Date.now() + 60_000 };
  return value;
}

// ---------- static map layers (e.g. metro line) ----------
export async function getLayer(name) {
  if (!LAYERS.includes(name)) return null;
  if (!usingDb) return JSON.parse(await readFile(path.join(ROOT, "data", `${name}.geojson`), "utf8"));
  await ensureSchema();
  const q = await getSql();
  const [r] = await q`SELECT geojson FROM layers WHERE name = ${name}`;
  return r ? r.geojson : null;
}
