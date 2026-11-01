// Billboard + creative storage. Neon Postgres when DATABASE_URL is set, otherwise local files in data/.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, unlink, mkdir, copyFile, readdir } from "node:fs/promises";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BILLBOARDS_FILE = path.join(ROOT, "data", "billboards.geojson");
const CREATIVES_DIR = path.join(ROOT, "data", "creatives");
const MIME = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

export const usingDb = !!process.env.DATABASE_URL;

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
