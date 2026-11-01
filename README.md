# Chennai 3D Live

Interactive, photorealistic 3D model of Chennai built on Google Photorealistic 3D Tiles
(rendered with CesiumJS), with live data overlays and a click-to-measure height tool
aimed at outdoor advertising (hoardings, billboards).

```
browser (CesiumJS)  ──polls JSON──▶  Express proxy  ──▶  Google Routes / Air Quality / Weather
   ├─ Google 3D Tiles (browser key)        ├─ holds server key
   ├─ traffic / air / weather / billboards ├─ short TTL cache
   └─ measure tool                         └─ serves data/billboards.geojson
```

## Setup

1. Google Cloud project with billing. Enable: **Map Tiles API**, **Routes API**,
   **Air Quality API**, **Weather API** (Places API (New) optional, not wired yet).
2. Two API keys:
   - **Browser key**: Map Tiles API only, restricted by HTTP referrer
     (`http://localhost:3000/*`, your domain).
   - **Server key**: Routes, Air Quality, Weather. Restrict by IP if possible. Never ship to browser.
3. Configure and run:

```bash
cp .env.example .env     # fill GOOGLE_BROWSER_KEY and GOOGLE_SERVER_KEY
npm install
npm run dev              # http://localhost:3000
```

Node 22+ required (uses `--env-file-if-exists`).

## Files

| Path | Purpose |
|------|---------|
| `server/index.js` | Express: `/config.js` (browser key), `/api/traffic`, `/api/air`, `/api/weather`, `/api/billboards`, static `public/` |
| `server/config.js` | Traffic corridors, air-quality points, weather point, cache TTLs |
| `public/app.js` | Viewer (`/`): 3D map, Street View, search, weather/AQI widget, billboard card. Read-only. |
| `public/admin.js` | Billboard panel (`/admin.html`): pick a board, upload its creative, align it on Street View, save. |
| `public/sv-math.js` | Shared Street View geometry: camera model, projection, homography, alignment fits. |
| `data/billboards.geojson` | Your own billboard survey data (sample included) |
| `data/creatives/` | Uploaded creative images (served at `/creatives/`) |

## Using it

**Viewer** (`http://localhost:3000/`, optional `?id=BB-…`): Street View is the main view with the
3D map inset (Swap flips them). The left card shows the current board, its live traffic speed and a
Street View photo. Search a place or board at the top; weather and AQI sit on the right. Click a board
in the 3D map or pick it from search. The viewer does not edit anything.

**Billboard panel** (`http://localhost:3000/admin.html`, or the Panel button / "Edit creative &
alignment" link in the viewer):

1. Pick the billboard.
2. Upload its creative image (or Remove). It is stored under `data/creatives/` and shown on the board
   in Street View and the 3D map.
3. Click **Align**, drag the four yellow corners onto the real board in the panorama, then **Save
   layout**. The alignment is stored per panorama; the 3D position, size and facing are fitted from
   it. Walk to a second spot and align again to triangulate the exact position. The saved-panoramas
   list lets you jump to a pano, make it the default (used by the viewer and the card photo) or
   remove it.

An open viewer tab reloads the records as soon as the panel saves.

## Billboard data

Google tiles are one textured mesh with no objects or attributes, so billboard records
must come from your own survey, drone/LiDAR capture, or GCC permit records.
Edit `data/billboards.geojson`. Point features with properties:

```
id, base_height_m, board_height_m, width_m, heading_deg, owner, permit_no, photo_url, surveyed_on, type
```

`base_height_m` is height of the board's bottom edge above local ground; ground elevation is
sampled from the mesh at load time. `heading_deg` rotates the box (0 = north-facing face).

## Accuracy and terms

- Mesh heights are approximate (expect ±1 m or worse); thin/pole boards may be missing or blurred. Imagery may be old.
- Measurements are for on-screen checks only. Do not build a dataset by systematically extracting heights from Google content; that may violate Google Maps Platform terms.
- Tiles must stream; do not cache or download the mesh.
- Google has no citywide raw traffic feed. Corridors are sampled with the Routes API; add more in `server/config.js` (each is one billable request per cache refresh).

## Extending

- Add a corridor or sensor point: edit `server/config.js`.
- New live layer: add a route in `server/index.js`, then `defineLayer(...)` in `public/app.js`.
- Verify API shapes against current Google docs; Weather API fields in particular may change.
