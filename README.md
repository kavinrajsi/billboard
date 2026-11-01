# Chennai 3D Live

Interactive 3D map of Chennai for outdoor advertising (billboards, hoardings).
Built on Google Photorealistic 3D Tiles (CesiumJS) with Street View, live traffic,
air quality and weather, plus a panel to upload and align billboard creatives.

## What you get

- **Viewer** (`/`): Street View as the main view, 3D map as an inset (swap with one click).
- **Billboard card**: board details, live traffic speed nearby, Street View photo.
- **Live layers**: traffic corridors, air quality, weather, Chennai Metro Blue Line.
- **Search**: find a place (Google Places) or a billboard by id.
- **Billboard panel** (`/admin.html`): upload a creative, align it on Street View, save.
- **Auto-align (AI)**: optional, uses Anthropic to suggest the four board corners.

## How it works

```
browser (CesiumJS + Street View)         Express server (Node)
  ├─ 3D Tiles ........ browser key         ├─ holds the server key, never sent to the browser
  ├─ polls /api/* ──────────────────────▶  ├─ calls Google Routes / Air Quality / Weather / Places
  └─ billboards, creatives, metro line     ├─ short in-memory cache (see CACHE_TTL)
                                           └─ reads and writes data/billboards.geojson
```

## Quick start

**Needs:** Node 22 or newer, a Google Cloud project with billing.

1. **Enable these Google APIs:** Map Tiles, Routes, Air Quality, Weather, Places (New).
2. **Create two API keys:**

   | Key | Used for | Restrict to |
   |-----|----------|-------------|
   | Browser key | Map Tiles API (sent to the browser) | Map Tiles API + HTTP referrers (`http://localhost:3000/*`, your domain) |
   | Server key | Routes, Air Quality, Weather, Places | Those APIs + server IP if possible |

3. **Configure and run:**

   ```bash
   cp .env.example .env.local
   # fill in the keys (see below)
   npm install
   npm run dev      # http://localhost:3000
   ```

Use `npm start` for a run without file watching.

## Environment variables

Set in `.env.local` (git-ignored, never commit it).

| Variable | Required | Purpose |
|----------|----------|---------|
| `GOOGLE_BROWSER_KEY` | yes | 3D Tiles in the browser |
| `GOOGLE_SERVER_KEY` | yes | Traffic, air, weather, places (server only) |
| `ANTHROPIC_API_KEY` | no | Enables "Auto-align (AI)" in the panel |
| `AUTO_ALIGN_MODEL` | no | Override the AI model (default `claude-opus-5-5`) |
| `PORT` | no | Server port (default `3000`) |

## Using the app

### Viewer: `http://localhost:3000/`

- Add `?id=SKY-91` to open a specific billboard.
- Search a place or board at the top. Weather and AQI show on the right.
- Click a board in the 3D map, or pick it from search, to open its card.
- The viewer is read-only.

### Billboard panel: `http://localhost:3000/admin.html`

1. Pick the billboard.
2. Upload its creative image (png, jpeg, webp or gif, up to 10 MB). Use Remove to delete it.
3. Click **Align**, drag the four yellow corners onto the real board in the panorama,
   then **Save layout**.
4. Optional: walk to a second spot and align again. Two panoramas triangulate the
   exact 3D position, size and facing.
5. In the saved-panoramas list you can jump to a pano, make it the default
   (used by the viewer and the card photo), or remove it.

An open viewer tab reloads the data as soon as the panel saves.

## Project layout

| Path | Purpose |
|------|---------|
| `server/index.js` | Express app: API routes, uploads, static files |
| `server/config.js` | Traffic corridors, air-quality points, weather point, cache TTLs |
| `public/index.html`, `app.js`, `style.css` | Viewer |
| `public/admin.html`, `admin.js`, `admin.css` | Billboard panel |
| `public/sv-math.js` | Street View geometry: camera model, projection, alignment fits |
| `data/billboards.geojson` | Billboard survey data (sample included) |
| `data/metro-blue-line.geojson` | Metro Blue Line route |
| `data/creatives/` | Uploaded creative images, served at `/creatives/` |

## API routes

| Route | What it does |
|-------|--------------|
| `GET /config.js` | Passes the browser key to the page |
| `GET /api/traffic` | Speed and delay for each corridor |
| `GET /api/air` | Air quality at the configured points |
| `GET /api/air/point` | Air quality for one location |
| `GET /api/weather` | Current weather |
| `GET /api/places/autocomplete` | Place search suggestions |
| `GET /api/places/:placeId` | Place details |
| `GET /api/metro/blue` | Metro Blue Line GeoJSON |
| `GET /api/billboards` | All billboards (GeoJSON) |
| `GET /api/billboards/:id/speed` | Live traffic speed near one board |
| `GET /api/billboards/:id/photo` | Street View photo for one board |
| `PUT /api/billboards/:id/creative` | Upload a creative image |
| `DELETE /api/billboards/:id/creative` | Remove the creative |
| `PUT /api/billboards/:id/streetview` | Save a panorama alignment |
| `POST /api/billboards/:id/auto-align` | AI suggestion for the four corners |

> The write routes (`PUT`, `POST`, `DELETE`) have **no login**. Run the panel locally
> or put the server behind authentication before exposing it on the internet.

## Billboard data

Google tiles are one textured mesh with no object data, so billboard records come from
your own survey, drone/LiDAR capture, or GCC permit records. Edit `data/billboards.geojson`
by hand or through the panel. Each feature is a Point with these properties:

| Property | Meaning |
|----------|---------|
| `id`, `name`, `area`, `landmark` | Identity and place |
| `owner`, `type`, `source` | Who runs it, format (e.g. Digital LED screen), data source |
| `width_m`, `board_height_m`, `size_ft`, `pixel_resolution` | Size |
| `base_height_m` | Height of the board's bottom edge above local ground |
| `heading_deg` | Facing direction (0 = north) |
| `daily_footfall`, `traffic_hours`, `audience_profile`, `why_this_location` | Audience info |
| `creative_url` | Set when a creative is uploaded |
| `sv_pano_id`, `corners`, `geometry_source`, `position_source` | Street View alignment, written by the panel |

Ground elevation is sampled from the mesh when the page loads.

## Customising

- **Add a traffic corridor, air point or weather point:** edit `server/config.js`.
  Each corridor costs one billable Routes request per cache refresh.
- **Change cache times:** `CACHE_TTL` in `server/config.js`.
- **Add a live layer:** add a route in `server/index.js`, then `defineLayer(...)` in `public/app.js`.

## Accuracy and terms

- Mesh heights are approximate (expect ±1 m or worse). Thin or pole boards may be missing or blurred. Imagery may be old.
- Measurements are for on-screen checks only. Do not build a dataset by systematically
  extracting heights from Google content; that may violate Google Maps Platform terms.
- Tiles must stream. Do not cache or download the mesh.
- Google has no citywide raw traffic feed, so corridors are sampled with the Routes API.
- Check API response shapes against current Google docs. Weather API fields in particular may change.
