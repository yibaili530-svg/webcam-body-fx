// Effect 2 (Slices): a deformed grid of SLICE_ROWS rows and sliceColumns(aspect) columns.
// Every row line and every column line (per row) is a bounded, moving function of time, so the
// cell boundaries move and cell widths and heights (aspect ratios) change continuously. Each
// cell shows the camera content of its rest rectangle, shifted by a bounded per-cell offset, so
// the content is stretched or compressed with the cell and the cells never line up at rest.
// COMPOSITE_FRAG in view.js mirrors this in GLSL and interpolates the constants below, so they
// have one source of truth. Plain numbers only: this module has no DOM.

import { EFFECT_TEMPO } from './tempo.js';

export const SLICE_ROWS = 10;
export const SLICE_MIN_COLS = 6;
export const SLICE_MAX_COLS = 20;
/**
 * Largest boundary displacement, in cell units. Below 0.5, so neighbouring boundaries can
 * never cross: every row and column stays positive in size (width from 0.2 to 1.8 cells).
 */
export const SLICE_EDGE_AMP = 0.4;
/** Largest per-cell content shift, in cell units. */
export const SLICE_CONTENT_AMP = 0.5;
/** Second harmonic weight; the sum is divided by (1 + harmonic), so |wave| <= 1. */
export const SLICE_HARMONIC = 0.4;
/**
 * Angular frequencies, rad/s. The band keeps its 0.6 : 1.4 form (min : range) but is scaled so its mean,
 * SLICE_FREQ_MIN + SLICE_FREQ_RANGE / 2 = 1.3 before scaling, equals the shared ripple rate (EFFECT_TEMPO).
 */
const SLICE_FREQ_SCALE = EFFECT_TEMPO / (0.6 + 1.4 / 2);
export const SLICE_FREQ_MIN = 0.6 * SLICE_FREQ_SCALE;
export const SLICE_FREQ_RANGE = 1.4 * SLICE_FREQ_SCALE;
/** Cell ids are line * SLICE_ID_STRIDE + index; the stride must exceed the largest column count. */
export const SLICE_ID_STRIDE = 64;

const TAU = 6.28318;
const fract = (x) => x - Math.floor(x);

/** Same hash as view.js hash() in GLSL (sin-based; GPU float rounding differs in the last digits). */
export function sliceHash(x) {
  return fract(Math.sin(x * 12.9898 + 78.233) * 43758.5453);
}

/** Column count for a viewport aspect (w / h): cells stay near square at rest. */
export function sliceColumns(aspect) {
  if (!(aspect > 0)) return SLICE_MIN_COLS;
  return Math.min(SLICE_MAX_COLS, Math.max(SLICE_MIN_COLS, Math.round(SLICE_ROWS * aspect)));
}

/**
 * Bounded wave in [-1, 1] for a given id and channel. Independent seeds per id, so the boundaries
 * and offsets never follow one shared phase.
 */
export function sliceWave(id, channel, t) {
  const s = sliceHash(id * 0.917 + channel * 4.13 + 0.61);
  const w1 = SLICE_FREQ_MIN + SLICE_FREQ_RANGE * fract(s * 7.31);
  const w2 = SLICE_FREQ_MIN + SLICE_FREQ_RANGE * fract(s * 13.17);
  const p1 = TAU * fract(s * 3.91);
  const p2 = TAU * fract(s * 5.77);
  return (Math.sin(t * w1 + p1) + SLICE_HARMONIC * Math.sin(t * w2 + p2)) / (1 + SLICE_HARMONIC);
}

/**
 * Boundary k (0..n) of a line of n cells, in normalized [0, 1]. line 0 is the row lines; line
 * 1 + row is the column lines of that row. Edges (k = 0 and k = n) are fixed at 0 and 1.
 */
export function sliceEdge(k, n, line, t) {
  if (k <= 0) return 0;
  if (k >= n) return 1;
  return (k + SLICE_EDGE_AMP * sliceWave(line * SLICE_ID_STRIDE + k, 0, t)) / n;
}

/**
 * The deformed cell containing a normalized screen point at time t, with `cols` columns. The row
 * is found first; the column lines belong to that row. Returns indices and deformed rectangle.
 */
export function sliceCell(x, y, t, cols) {
  const yy = Math.min(Math.max(y, 0), 0.999999);
  const j0 = Math.min(SLICE_ROWS - 1, Math.max(0, Math.floor(yy * SLICE_ROWS)));
  let row = j0;
  let top = sliceEdge(j0, SLICE_ROWS, 0, t);
  let bottom = sliceEdge(j0 + 1, SLICE_ROWS, 0, t);
  for (let i = 0; i < 3; i++) {
    const j = Math.min(SLICE_ROWS - 1, Math.max(0, j0 - 1 + i));
    const a = sliceEdge(j, SLICE_ROWS, 0, t);
    const b = sliceEdge(j + 1, SLICE_ROWS, 0, t);
    if (yy >= a && yy < b) { row = j; top = a; bottom = b; }
  }

  const xx = Math.min(Math.max(x, 0), 0.999999);
  const k0 = Math.min(cols - 1, Math.max(0, Math.floor(xx * cols)));
  let col = k0;
  let left = sliceEdge(k0, cols, 1 + row, t);
  let right = sliceEdge(k0 + 1, cols, 1 + row, t);
  for (let i = 0; i < 3; i++) {
    const k = Math.min(cols - 1, Math.max(0, k0 - 1 + i));
    const a = sliceEdge(k, cols, 1 + row, t);
    const b = sliceEdge(k + 1, cols, 1 + row, t);
    if (xx >= a && xx < b) { col = k; left = a; right = b; }
  }
  return { row, col, top, bottom, left, right, id: row * SLICE_ID_STRIDE + col };
}

/**
 * Where a screen point takes its camera content from, in normalized screen coordinates: the
 * cell's rest rectangle, stretched to the deformed cell and shifted by the cell's offset, then
 * clamped to the frame. Also returns the cell.
 */
export function sliceSource(x, y, t, cols) {
  const cell = sliceCell(x, y, t, cols);
  const u = (x - cell.left) / (cell.right - cell.left);
  const v = (y - cell.top) / (cell.bottom - cell.top);
  const sx = (cell.col + u + SLICE_CONTENT_AMP * sliceWave(cell.id, 1, t)) / cols;
  const sy = (cell.row + v + SLICE_CONTENT_AMP * sliceWave(cell.id, 2, t)) / SLICE_ROWS;
  return {
    src: { x: Math.min(1, Math.max(0, sx)), y: Math.min(1, Math.max(0, sy)) },
    cell,
  };
}

/**
 * Per-pixel effect-2 rule as COMPOSITE_FRAG applies it, for tests (hand mirror; keep in sync).
 * `region(p)` is the raw person mask max the hand matte, 0 or 1 (the shader's crisp edge is the
 * antialiased version). `camera(p)` is the camera value there. A destination pixel inside the
 * region takes its content from the source only when that source is itself inside the region;
 * otherwise it keeps the camera pixel. Background is never moved.
 */
export function sliceComposite(screen, t, { cols, region, camera }) {
  const cam = camera(screen);
  if (region(screen) <= 0) return cam;
  const { src } = sliceSource(screen.x, screen.y, t, cols);
  return region(src) > 0 ? camera(src) : cam;
}
