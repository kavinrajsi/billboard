// Street View geometry shared by the viewer (app.js) and the admin panel (admin.js).
// Pure functions: no DOM, no Cesium. Angles in degrees unless noted; ENU metres (x east, y north, z up).

export const R_EARTH = 6378137;
export const SV_CAM_HEIGHT = 2.5; // Street View car camera height above road, metres

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export function metresBetween(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng) * Math.cos(rad((a.lat + b.lat) / 2));
  return Math.sqrt(dLat * dLat + dLng * dLng) * R_EARTH;
}
export function bearingDeg(a, b) {
  const la1 = rad(a.lat), la2 = rad(b.lat), dLng = rad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

// Camera frame for a POV: forward/right/up in ENU, focal length in px for a W×H stage.
export function svCamera(pov, zoom, W, H) {
  const h = rad(pov.heading), p = rad(pov.pitch);
  const fwd = [Math.sin(h) * Math.cos(p), Math.cos(h) * Math.cos(p), Math.sin(p)];
  const right = [Math.cos(h), -Math.sin(h), 0];
  const up = [-Math.sin(h) * Math.sin(p), -Math.cos(h) * Math.sin(p), Math.cos(p)];
  const hfov = rad(180 / Math.pow(2, zoom ?? 1));
  const f = (W / 2) / Math.tan(Math.min(hfov, rad(150)) / 2);
  return { W, H, fwd, right, up, f };
}
export const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Direction vector (ENU) → screen px, or null if behind the camera.
export function svProject(c, v, minZ = 1e-6) {
  const z = dot3(v, c.fwd);
  if (z < minZ) return null;
  return [c.W / 2 + c.f * dot3(v, c.right) / z, c.H / 2 - c.f * dot3(v, c.up) / z];
}
// Screen px → absolute {heading, pitch}.
export function svUnproject(c, x, y) {
  const a = (x - c.W / 2) / c.f, b = -(y - c.H / 2) / c.f;
  const v = [c.fwd[0] + a * c.right[0] + b * c.up[0], c.fwd[1] + a * c.right[1] + b * c.up[1], c.fwd[2] + a * c.right[2] + b * c.up[2]];
  const n = Math.hypot(...v);
  return { heading: (deg(Math.atan2(v[0], v[1])) + 360) % 360, pitch: deg(Math.asin(v[2] / n)) };
}
export const angToVec = ({ heading, pitch }) => {
  const h = rad(heading), p = rad(pitch);
  return [Math.sin(h) * Math.cos(p), Math.cos(h) * Math.cos(p), Math.sin(p)];
};

// Board corners (TL, TR, BR, BL) in ENU metres from the camera, and whether the camera sees the back.
// g: { lng, lat, base, bh, bw, heading }  cam: { lng, lat }
export function boardCornersENU(g, cam) {
  const cosLat = Math.cos(rad(cam.lat));
  const E0 = rad(g.lng - cam.lng) * R_EARTH * cosLat;
  const N0 = rad(g.lat - cam.lat) * R_EARTH;
  const along = rad(g.heading + 90); // board width runs perpendicular to its facing
  const ax = Math.sin(along) * g.bw / 2, ay = Math.cos(along) * g.bw / 2;
  const zb = g.base - SV_CAM_HEIGHT, zt = zb + g.bh;
  const nrm = [Math.sin(rad(g.heading)), Math.cos(rad(g.heading))];
  const back = (nrm[0] * -E0 + nrm[1] * -N0) < 0;
  // Viewer facing the front looks along -normal, so the board's ends swap sides on screen.
  const sgn = back ? 1 : -1;
  const corners = [
    [E0 - sgn * ax, N0 - sgn * ay, zt], [E0 + sgn * ax, N0 + sgn * ay, zt],
    [E0 + sgn * ax, N0 + sgn * ay, zb], [E0 - sgn * ax, N0 - sgn * ay, zb],
  ];
  return { corners, back };
}

// Geometric projection of the board into the current view: { pts, back } or null when any corner is behind.
export function projectBoard(g, cam, c) {
  const { corners, back } = boardCornersENU(g, cam);
  const pts = [];
  for (const v of corners) {
    const pt = svProject(c, v, 0.5);
    if (!pt) return null;
    pts.push(pt);
  }
  return { pts, back };
}

// Solve the projective transform mapping 4 src points to 4 dst points; returns CSS matrix3d values.
export function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const n = 8;
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (Math.abs(A[piv][c]) < 1e-9) return null;
    [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = A[r][c] / A[c][c];
      for (let j = c; j < n; j++) A[r][j] -= k * A[c][j];
      b[r] -= k * b[c];
    }
  }
  const t = b.map((v, i) => v / A[i][i]); // a b c d e f g h
  // CSS matrix3d is column-major 4x4; map 3x3 homography [[a,b,c],[d,e,f],[g,h,1]].
  return [t[0], t[3], 0, t[6],  t[1], t[4], 0, t[7],  0, 0, 1, 0,  t[2], t[5], 0, 1];
}

// Place an element over 4 screen points: returns the CSS transform string or null.
export function boardTransform(el, pts) {
  const bw = el.offsetWidth || 200, bh = el.offsetHeight || 100;
  const m = homography([[0, 0], [bw, 0], [bw, bh], [0, bh]], pts);
  return m ? `matrix3d(${m.join(",")})` : null;
}

// Triangulate board corners from ≥2 panos with known positions. ENU metres relative to the first pano.
// entries: [{ corners: [4×{heading,pitch}], lat, lng }]
export function triangulateFromAlignments(entries) {
  const base = entries[0];
  const enu = (lat, lng) => [rad(lng - base.lng) * R_EARTH * Math.cos(rad(base.lat)), rad(lat - base.lat) * R_EARTH, 0];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const pts = [];
  for (let k = 0; k < 4; k++) {
    // least-squares point closest to all rays: sum (I - d d^T)(x - p) = 0
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
    for (const e of entries) {
      const p0 = enu(e.lat, e.lng), d = angToVec(e.corners[k]);
      const M = [[1 - d[0] * d[0], -d[0] * d[1], -d[0] * d[2]], [-d[1] * d[0], 1 - d[1] * d[1], -d[1] * d[2]], [-d[2] * d[0], -d[2] * d[1], 1 - d[2] * d[2]]];
      for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) A[i][j] += M[i][j]; b[i] += M[i][0] * p0[0] + M[i][1] * p0[1] + M[i][2] * p0[2]; }
    }
    const x = solve3(A, b);
    if (!x) return null;
    pts.push(x);
  }
  const [tl, tr, br, bl] = pts;
  const len = (v) => Math.hypot(v[0], v[1], v[2]);
  const width = (len(sub(tr, tl)) + len(sub(br, bl))) / 2;
  const height = ((tl[2] - bl[2]) + (tr[2] - br[2])) / 2;
  const bottom = (bl[2] + br[2]) / 2 + SV_CAM_HEIGHT;
  const c = [0, 1, 2].map((i) => (tl[i] + tr[i] + br[i] + bl[i]) / 4);
  const edge = sub(tr, tl);
  let facing = (deg(Math.atan2(edge[0], edge[1])) - 90 + 360) % 360; // left normal of TL→TR
  const toCam = sub([0, 0, 0], c); // choose the side that faces the first camera
  const n = [Math.sin(rad(facing)), Math.cos(rad(facing))];
  if (n[0] * toCam[0] + n[1] * toCam[1] < 0) facing = (facing + 180) % 360;
  const lat = base.lat + deg(c[1] / R_EARTH);
  const lng = base.lng + deg(c[0] / (R_EARTH * Math.cos(rad(base.lat))));
  if (!(width > 0.3) || !(height > 0.2)) return null;
  return { lat, lng, width_m: width, board_height_m: height, base_height_m: Math.max(0, bottom), heading_deg: facing, distance: Math.hypot(c[0], c[1]) };
}
function solve3(A, b) {
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < 3; c++) {
    let piv = c; for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-9) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < 3; r++) { if (r === c) continue; const k = M[r][c] / M[c][c]; for (let j = c; j < 4; j++) M[r][j] -= k * M[c][j]; }
  }
  return M.map((r, i) => r[3] / r[i]);
}

// Rectangle-model fit: the board is a vertical rectangle (centre E/N, bottom z, width, height, facing) seen from
// one or more panos with known positions. Least squares on corner angles (Gauss-Newton with damping), with a weak
// prior on width toward `width0`. Far better conditioned than free corner triangulation when the panos lie along
// the same road as the board. entries: [{ corners, lat, lng }], ENU relative to entries[0].
export function fitRectangleFromAlignments(entries, width0 = 5, widthPrior = 0.3) {
  const base = entries[0];
  const enu = (lat, lng) => [rad(lng - base.lng) * R_EARTH * Math.cos(rad(base.lat)), rad(lat - base.lat) * R_EARTH];
  const cams = entries.map((e) => enu(e.lat, e.lng));
  // initial guess: single-pano fit from the first entry
  const f0 = fitGeometryFromCorners(base.corners, { lat: base.lat, lng: base.lng }, width0);
  if (!f0) return null;
  const c0 = enu(f0.lat, f0.lng);
  let x = [c0[0], c0[1], f0.base_height_m, width0, f0.board_height_m, f0.heading_deg];
  const wrap = (d) => ((d + 540) % 360) - 180;
  const residuals = (x) => {
    const [E, N, zb, w, h, phi] = x;
    const along = rad(phi + 90), ax = Math.sin(along) * w / 2, ay = Math.cos(along) * w / 2;
    const nrm = [Math.sin(rad(phi)), Math.cos(rad(phi))];
    const r = [];
    entries.forEach((e, k) => {
      const [cx, cy] = cams[k];
      const E0 = E - cx, N0 = N - cy;
      const back = (nrm[0] * -E0 + nrm[1] * -N0) < 0;
      const sgn = back ? 1 : -1;
      const zT = zb + h - SV_CAM_HEIGHT, zB = zb - SV_CAM_HEIGHT;
      const corners = [[E0 - sgn * ax, N0 - sgn * ay, zT], [E0 + sgn * ax, N0 + sgn * ay, zT], [E0 + sgn * ax, N0 + sgn * ay, zB], [E0 - sgn * ax, N0 - sgn * ay, zB]];
      corners.forEach((v, i) => {
        const hd = deg(Math.atan2(v[0], v[1])), pt = deg(Math.asin(v[2] / Math.hypot(v[0], v[1], v[2])));
        r.push(wrap(hd - e.corners[i].heading), pt - e.corners[i].pitch);
      });
    });
    r.push((w - width0) * widthPrior);
    return r;
  };
  const norm2 = (r) => r.reduce((a, v) => a + v * v, 0);
  let lambda = 1e-2, cost = norm2(residuals(x));
  const steps = [0.05, 0.05, 0.02, 0.02, 0.02, 0.1];
  for (let it = 0; it < 60; it++) {
    const r0 = residuals(x), m = r0.length;
    const J = x.map((_, j) => { const xp = x.slice(); xp[j] += steps[j]; return residuals(xp).map((v, i) => (v - r0[i]) / steps[j]); });
    const A = x.map((_, i) => x.map((_, j) => { let s = 0; for (let k = 0; k < m; k++) s += J[i][k] * J[j][k]; return s; }));
    const g = x.map((_, i) => { let s = 0; for (let k = 0; k < m; k++) s += J[i][k] * r0[k]; return -s; });
    let improved = false;
    for (let tries = 0; tries < 8 && !improved; tries++) {
      const Ad = A.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lambda) : v)));
      const d = solveN(Ad, g);
      if (!d) { lambda *= 10; continue; }
      const xn = x.map((v, i) => v + d[i]);
      xn[3] = Math.max(0.3, xn[3]); xn[4] = Math.max(0.2, xn[4]); xn[2] = Math.max(0, xn[2]); xn[5] = (xn[5] % 360 + 360) % 360;
      const cn = norm2(residuals(xn));
      if (cn < cost) { x = xn; cost = cn; lambda = Math.max(1e-6, lambda / 3); improved = true; }
      else lambda *= 10;
    }
    if (!improved || Math.sqrt(cost / m) < 1e-4) break;
  }
  const [E, N, zb, w, h, phi] = x;
  const lat = base.lat + deg(N / R_EARTH);
  const lng = base.lng + deg(E / (R_EARTH * Math.cos(rad(base.lat))));
  const rms = Math.sqrt(cost / (entries.length * 8));
  return { lat, lng, width_m: w, board_height_m: h, base_height_m: zb, heading_deg: phi, distance: Math.hypot(E, N), rmsDeg: rms };
}
function solveN(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) { if (r === c) continue; const k = M[r][c] / M[c][c]; for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}

// Fit board position/size from one pano's aligned corners, using the record's width as the scale and the
// Street View camera height. Assumes a vertical rectangle facing the camera.
export function fitGeometryFromCorners(corners, cam, widthM) {
  const [tl, tr, br, bl] = corners;
  const hL = (tl.heading + bl.heading) / 2, hR = (tr.heading + br.heading) / 2;
  const dh = Math.abs(((hR - hL + 540) % 360) - 180);
  if (dh < 0.2) return null;
  const hc = (hL + (((hR - hL + 540) % 360) - 180) / 2 + 360) % 360;
  const d = widthM / (2 * Math.tan(rad(dh) / 2));
  const pT = (tl.pitch + tr.pitch) / 2, pB = (bl.pitch + br.pitch) / 2;
  const top = d * Math.tan(rad(pT)) + SV_CAM_HEIGHT;
  const bottom = d * Math.tan(rad(pB)) + SV_CAM_HEIGHT;
  const lat = cam.lat + deg((d * Math.cos(rad(hc))) / R_EARTH);
  const lng = cam.lng + deg((d * Math.sin(rad(hc))) / (R_EARTH * Math.cos(rad(cam.lat))));
  return {
    lat, lng, distance: d,
    base_height_m: Math.max(0, bottom), board_height_m: Math.max(0.2, top - bottom), width_m: widthM,
    heading_deg: (hc + 180) % 360, // faces the camera
  };
}

// Fit geometry from every saved alignment of a record (plus the current one when given): rectangle fit across
// panos when ≥2 have positions, else single-pano fit. Returns { fit, method }.
export function fitFromAlignments(props, pano, corners, cam) {
  const entries = Object.entries(props.sv_alignments || {})
    .filter(([pid, a]) => pid !== pano && a && !Array.isArray(a) && Number.isFinite(a.lat))
    .map(([, a]) => a);
  if (corners && cam) entries.unshift({ corners, lat: cam.lat, lng: cam.lng });
  if (!entries.length) return { fit: null, method: "none" };
  const width0 = Number(props.width_m) || 5;
  let fit = entries.length >= 2 ? fitRectangleFromAlignments(entries, width0) : null;
  const method = fit ? `fitted across ${entries.length} panos` : "single-pano fit";
  if (!fit) fit = fitGeometryFromCorners(entries[0].corners, { lat: entries[0].lat, lng: entries[0].lng }, width0);
  return { fit, method };
}

// Saved corners for a pano on a record, tolerating older shapes.
export function savedCorners(props, pano) {
  if (!props || !pano) return null;
  const a = props.sv_alignments?.[pano];
  if (a) return Array.isArray(a) ? a : a.corners;
  if (props.sv_corners && props.sv_pano_id === pano) return props.sv_corners;
  return null;
}

// Geometry record used by both pages, built from GeoJSON feature properties + coordinates.
export function geomFromFeature(f) {
  const p = f.properties || {};
  return {
    lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1],
    base: Number(p.base_height_m) || 0, bh: Number(p.board_height_m) || 3, bw: Number(p.width_m) || 6,
    heading: Number(p.heading_deg) || 0,
  };
}
