// Pure hand-silhouette geometry, approximated from the 21 HandLandmarker points. Not a
// per-pixel segmentation: a filled palm polygon plus a tapered capsule per finger bone, so
// spread fingers keep the gaps between them. Works in raster pixels of a source-space
// matte (unmirrored, row 0 at the top) whose aspect matches the video, so the shapes stay
// round. No DOM.

export const PALM = [0, 1, 5, 9, 13, 17];
export const FINGERS = [
  [1, 2, 3, 4], // thumb
  [5, 6, 7, 8], // index
  [9, 10, 11, 12], // middle
  [13, 14, 15, 16], // ring
  [17, 18, 19, 20], // pinky
];

// Fractions of the hand size (wrist -> middle MCP).
const FINGER_RADIUS = 0.1;
const THUMB_RADIUS = 0.12;
const TIP_RADIUS_SCALE = 0.65;
const PALM_PAD = 0.08;
const MIN_HAND_PX = 1;

/**
 * Shapes for one hand in raster pixels, or null when the landmarks can't form a hand
 * (missing, non-finite, or collapsed to a point).
 */
export function handShapes(landmarks, w, h) {
  if (!landmarks || landmarks.length < 21) return null;
  const pts = [];
  for (let i = 0; i < 21; i++) {
    const x = landmarks[i].x * w;
    const y = landmarks[i].y * h;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    pts.push({ x, y });
  }
  const size = Math.hypot(pts[9].x - pts[0].x, pts[9].y - pts[0].y);
  if (size < MIN_HAND_PX) return null;

  const segments = [];
  FINGERS.forEach((chain, f) => {
    const base = size * (f === 0 ? THUMB_RADIUS : FINGER_RADIUS);
    const radius = (k) => base * (1 - (1 - TIP_RADIUS_SCALE) * (k / (chain.length - 1)));
    for (let k = 0; k < chain.length - 1; k++) {
      const a = pts[chain[k]];
      const b = pts[chain[k + 1]];
      segments.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, ra: radius(k), rb: radius(k + 1) });
    }
  });

  const palm = PALM.map((i) => pts[i]);
  const pad = size * PALM_PAD;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x, y, r) => {
    minX = Math.min(minX, x - r); maxX = Math.max(maxX, x + r);
    minY = Math.min(minY, y - r); maxY = Math.max(maxY, y + r);
  };
  palm.forEach((p) => grow(p.x, p.y, pad));
  segments.forEach((s) => { grow(s.ax, s.ay, s.ra); grow(s.bx, s.by, s.rb); });

  return { size, palm, pad, segments, bounds: { minX, minY, maxX, maxY } };
}

function segmentDistance(s, px, py) {
  const dx = s.bx - s.ax;
  const dy = s.by - s.ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((px - s.ax) * dx + (py - s.ay) * dy) / len2)) : 0;
  return Math.hypot(px - (s.ax + t * dx), py - (s.ay + t * dy)) - (s.ra + (s.rb - s.ra) * t);
}

function polygonDistance(poly, px, py) {
  let inside = false;
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j];
    const b = poly[i];
    if ((b.y > py) !== (a.y > py) && px < ((a.x - b.x) * (py - b.y)) / (a.y - b.y) + b.x) inside = !inside;
    best = Math.min(best, segmentDistance({ ax: a.x, ay: a.y, bx: b.x, by: b.y, ra: 0, rb: 0 }, px, py));
  }
  return inside ? -best : best;
}

/** Approximate signed distance in pixels to the hand outline; negative inside. */
export function handDistance(shapes, px, py) {
  let d = polygonDistance(shapes.palm, px, py) - shapes.pad;
  for (const s of shapes.segments) d = Math.min(d, segmentDistance(s, px, py));
  return d;
}

/**
 * Rasterizes all hands into `out` (w*h bytes, 0..255), clearing it first. `feather` is the
 * half-width of the soft edge in pixels. Shapes partly or fully outside the raster are
 * clipped. Returns whether any pixel was set.
 */
export function rasterizeHands(hands, w, h, out, feather = 1) {
  out.fill(0);
  let any = false;
  for (const landmarks of hands) {
    const shapes = handShapes(landmarks, w, h);
    if (!shapes) continue;
    const { minX, minY, maxX, maxY } = shapes.bounds;
    const x0 = Math.max(0, Math.floor(minX - feather));
    const y0 = Math.max(0, Math.floor(minY - feather));
    const x1 = Math.min(w - 1, Math.ceil(maxX + feather));
    const y1 = Math.min(h - 1, Math.ceil(maxY + feather));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = handDistance(shapes, x + 0.5, y + 0.5);
        if (d >= feather) continue;
        const v = Math.round(255 * Math.min(1, (feather - d) / (2 * feather)));
        const i = y * w + x;
        if (v > out[i]) out[i] = v;
        any = true;
      }
    }
  }
  return any;
}

/** Nearest-pixel matte value (0..1) at normalized source coordinates; 0 outside. */
export function sampleMatte(out, w, h, u, v) {
  if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) return 0;
  const x = Math.min(w - 1, Math.floor(u * w));
  const y = Math.min(h - 1, Math.floor(v * h));
  return out[y * w + x] / 255;
}
