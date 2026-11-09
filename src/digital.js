// Effect 5 (代码数字化) colour and motion: constants shared with the GLSL (view.js injects them) and the
// JS mirror of digitalColour() / digitalGlyph() in COMPOSITE_FRAG. The inputs are the cell's grid
// position, the time and the column index only. The camera is never read, so glyph shapes and colours
// carry no photographic content. Tests in tests/digital.test.js exercise these functions.

import { DIGITAL_ROWS, GLYPH_COLS, GLYPH_PAD, GLYPH_ROWS } from './glyphs.js';
import { EFFECT_TEMPO, TEMPO_PERIOD } from './tempo.js';

export const TAU = 6.28318; // the shader's literal

// Global palette cycle: one state at a time, held for DIGITAL_PALETTE_HOLD seconds, then the next:
// mono cyan, duo magenta + violet, mono amber, duo blue + cyan. Mono states show one hue on every cell;
// duo states give each cell one of its two colours by a stable per-cell hash. At most two chromatic
// hues are on screen at any time, and the switch is instant (no crossfade). Display-referred RGB.
export const DIGITAL_PALETTE_HOLD = 3 * TEMPO_PERIOD; // seconds per palette state: 3 ripple periods (about 1.35 s)
export const DIGITAL_CYAN = [0.0, 0.9, 1.0];
export const DIGITAL_MAGENTA = [1.0, 0.2, 0.8];
export const DIGITAL_VIOLET = [0.55, 0.25, 1.0];
export const DIGITAL_AMBER = [1.0, 0.6, 0.0];
export const DIGITAL_BLUE = [0.15, 0.4, 1.0];

// Letter glints: each cell's body brightness swells and fades at its own phase, smoothly, never below
// the floor, so every letter stays visible.
export const DIGITAL_GLINT_RATE = EFFECT_TEMPO; // rad/s of a cell's glint cycle: one glint per ripple period
export const DIGITAL_GLINT_FLOOR = 0.7; // dimmest body level of a glint, as a share of full

// Column streams: each column has its own head that runs down the screen at its own speed.
// Stream speeds are whole rows per ripple period (2 to 9 rows per period, about 4.5 to 20 rows/s at 88
// rows), so each column's pattern repeats once per period.
export const DIGITAL_STREAM_MIN = 2 / (DIGITAL_ROWS * TEMPO_PERIOD); // screen heights per second, slowest column
export const DIGITAL_STREAM_RANGE = 7 / (DIGITAL_ROWS * TEMPO_PERIOD); // added to the minimum: 2 to 9 rows per period
export const DIGITAL_TRAIL = 6.0; // brightness falls as exp(-TRAIL * distance behind the head)
export const DIGITAL_TRAIL_FLOOR = 0.25; // dimmest level of the trail
export const DIGITAL_HEAD_SHARP = 90.0; // head brightens to full hue as exp(-SHARP * distance behind the head)
export const DIGITAL_BG_LEVEL = 0.025; // opaque background: the cell hue at this linear brightness

/** Shader fract(). */
export function fract1(x) {
  return x - Math.floor(x);
}

/** Shader hash(float): the same expression as hash() in COMPOSITE_FRAG. */
export function hash1(n) {
  return fract1(Math.sin(n * 12.9898 + 78.233) * 43758.5453);
}

/**
 * Display-referred colour of a cell at time t. `pick` in [0, 1) is the cell's stable hash; it chooses
 * one colour of a duo state and is unused in a mono state.
 */
export function paletteHue(t, pick) {
  const state = ((Math.floor(t / DIGITAL_PALETTE_HOLD) % 4) + 4) % 4;
  if (state === 0) return DIGITAL_CYAN;
  if (state === 1) return pick < 0.5 ? DIGITAL_MAGENTA : DIGITAL_VIOLET;
  if (state === 2) return DIGITAL_AMBER;
  return pick < 0.5 ? DIGITAL_BLUE : DIGITAL_CYAN;
}

/** Head position of column `col` (screen heights from the top) at time t. */
export function streamHead(col, t) {
  const speed = DIGITAL_STREAM_MIN + DIGITAL_STREAM_RANGE * hash1(col * 1.37 + 0.5);
  return fract1(hash1(col * 2.31 + 0.9) + speed * t);
}

/** Distance in screen heights from a cell centre at height v up to the head, in [0, 1). */
export function headDistance(col, v, t) {
  return fract1(streamHead(col, t) - v);
}

/** Glyph index of the cell at (col, row) at time t. Identity changes once per ripple period, at a per-row phase. */
export function digitalGlyph(col, row, t, count) {
  const tick = Math.floor(t / TEMPO_PERIOD + hash1(row * 0.37 + 0.11));
  return Math.floor(hash1(col * 12.9898 + row * 78.233 + tick * 0.618) * count);
}

/** Atlas uv of glyph `index` at the local position (lu, lv) in [0, 1] of its cell, inset by GLYPH_PAD. */
export function glyphAtlasUv(index, lu, lv) {
  const col = index % GLYPH_COLS;
  const row = Math.floor(index / GLYPH_COLS);
  const inset = (x) => GLYPH_PAD + (1 - 2 * GLYPH_PAD) * x;
  return { u: (col + inset(lu)) / GLYPH_COLS, v: (row + inset(lv)) / GLYPH_ROWS };
}

/** Glint of the cell (col, row) at time t, in [DIGITAL_GLINT_FLOOR, 1]: a smooth sine at the cell's own phase. */
export function digitalGlint(col, row, t) {
  const wave = 0.5 + 0.5 * Math.sin(DIGITAL_GLINT_RATE * t + TAU * hash1(col * 7.77 + row * 2.13 + 0.61));
  return DIGITAL_GLINT_FLOOR + (1 - DIGITAL_GLINT_FLOOR) * Math.pow(wave, 3);
}

/**
 * Linear RGB of one cell: the glyph ink `ink` (atlas red, 0..1) mixed over an opaque dark background
 * tinted with the same hue. The head brightens toward the cell's own hue, never toward white. Nothing
 * here depends on the camera.
 */
export function digitalColour({ u, v, col, t, ink }) {
  const row = Math.floor(v * DIGITAL_ROWS); // the cell row; v is a cell centre
  const d = headDistance(col, v, t);
  const hue = paletteHue(t, hash1(col * 3.91 + row * 17.13 + 0.37)).map((c) => c * c); // display -> linear, as shadeFluid does
  const level = (DIGITAL_TRAIL_FLOOR + (1 - DIGITAL_TRAIL_FLOOR) * Math.exp(-DIGITAL_TRAIL * d)) * digitalGlint(col, row, t);
  const head = Math.exp(-DIGITAL_HEAD_SHARP * d);
  return hue.map((c) => {
    const glyph = c * (level + (1 - level) * head);
    const background = c * DIGITAL_BG_LEVEL;
    return background + (glyph - background) * ink;
  });
}
