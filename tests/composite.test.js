import { describe, expect, it } from 'vitest';
import { createCoverage } from '../src/coverage.js';
import { sliceComposite } from '../src/slices.js';

// Synthetic mask fixture (not real footage): 80 x 60 body ellipse with a 12 x 12 dropout, as in
// coverage.test.js. Screen space is normalized [0, 1]^2.
const W = 80;
const H = 60;
const inEllipse = (x, y, rx, ry) => ((x + 0.5 - 40) / rx) ** 2 + ((y + 0.5 - 30) / ry) ** 2 <= 1;
const raw = new Uint8Array(W * H);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const dropped = x >= 34 && x < 46 && y >= 24 && y < 36;
    if (inEllipse(x, y, 14, 22) && !dropped) raw[y * W + x] = 255;
  }
}
// Processed coverage: the 4 px dilation and hole fill from coverage.js.
const processed = new Uint8Array(W * H);
createCoverage(W, H).run(raw, processed);

// Hand matte: a small block far from the body (only the hand covers it).
const matte = new Uint8Array(W * H);
for (let y = 2; y < 7; y++) for (let x = 2; x < 7; x++) matte[y * W + x] = 255;

const at = (arr, p) => arr[Math.min(H - 1, Math.floor(p.y * H)) * W + Math.min(W - 1, Math.floor(p.x * W))];
const rawRegion = (p) => (at(raw, p) >= 128 ? 1 : 0);
const processedRegion = (p) => (at(processed, p) >= 128 ? 1 : 0);
const matteRegion = (p) => (at(matte, p) >= 128 ? 1 : 0);
// Effect 2 (slices) uses the RAW mask plus the hand union. Effects 1, 3 and 4 use the processed one; effect 5 is raw.
const rawUnion = (p) => Math.max(rawRegion(p), matteRegion(p));
const camera = (p) => 0.6 * p.x + 0.3 * p.y; // continuous, so any wrong source is visible

const T = 3.7;
const COLS = 18;
const run = (region, p) => sliceComposite(p, T, { cols: COLS, region, camera });

describe('raw vs processed mask', () => {
  it('the dropout is outside the raw mask but inside the processed coverage', () => {
    const hole = { x: 40 / W, y: 30 / H };
    expect(rawRegion(hole)).toBe(0);
    expect(processedRegion(hole)).toBe(1);
  });

  it('a pixel in the dropout is not moved by the raw-mask slices, but is by processed', () => {
    const p = { x: 40.5 / W, y: 30.5 / H };
    // Raw: outside the region, so the camera pixel stays.
    expect(run(rawUnion, p)).toBe(camera(p));
    // Processed coverage counts the dropout as inside, so the same pixel is rebuilt somewhere.
    let differs = 0;
    for (let y = 24; y < 36; y++) {
      for (let x = 34; x < 46; x++) {
        const q = { x: (x + 0.5) / W, y: (y + 0.5) / H };
        if (run(processedRegion, q) !== run(rawUnion, q)) differs++;
      }
    }
    expect(differs).toBeGreaterThan(0);
  });

  it('the raw mask never widens the region: raw-set pixels are the only ones that may change', () => {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = { x: (x + 0.5) / W, y: (y + 0.5) / H };
        if (rawUnion(p) === 0) expect(run(rawUnion, p)).toBe(camera(p));
      }
    }
  });
});

describe('background and source rules', () => {
  it('background pixels are exactly the camera value', () => {
    for (const p of [{ x: 0.02, y: 0.02 }, { x: 0.98, y: 0.5 }, { x: 0.5, y: 0.98 }]) {
      expect(rawUnion(p)).toBe(0);
      expect(run(rawUnion, p)).toBe(camera(p));
    }
  });

  it('a region pixel whose source falls outside the region keeps the camera pixel', () => {
    let kept = 0;
    let moved = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = { x: (x + 0.5) / W, y: (y + 0.5) / H };
        if (rawUnion(p) === 0) continue;
        const out = run(rawUnion, p);
        if (out === camera(p)) kept++;
        else moved++;
        expect(Number.isFinite(out)).toBe(true);
      }
    }
    expect(kept).toBeGreaterThan(0);
    expect(moved).toBeGreaterThan(0);
  });
});
