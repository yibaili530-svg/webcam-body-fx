import { describe, expect, it } from 'vitest';
import { COVERAGE_MAX_HOLE, COVERAGE_RADIUS, createCoverage } from '../src/coverage.js';

const R = COVERAGE_RADIUS;

const run = (w, h, src) => {
  const out = new Uint8Array(w * h);
  createCoverage(w, h).run(src, out);
  return out;
};

// Synthetic fixture (not real footage): an 80 x 60 mask with a body ellipse. `raw` undercovers:
// it is the true ellipse shrunk by UNDER px on every side, so the segmenter misses a known 2 px
// ring just inside the true outline. Optionally a 12 x 12 dropout is punched inside it.
const W = 80;
const H = 60;
const UNDER = 2;
const TRUE_RX = 16;
const TRUE_RY = 24;
const DROP = { x0: 34, x1: 46, y0: 24, y1: 36 };
const inEllipse = (x, y, rx, ry) => ((x + 0.5 - 40) / rx) ** 2 + ((y + 0.5 - 30) / ry) ** 2 <= 1;

function fixture({ dropout = true } = {}) {
  const truth = new Uint8Array(W * H);
  const raw = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (inEllipse(x, y, TRUE_RX, TRUE_RY)) truth[i] = 1;
      if (inEllipse(x, y, TRUE_RX - UNDER, TRUE_RY - UNDER)) raw[i] = 255;
      if (dropout && x >= DROP.x0 && x < DROP.x1 && y >= DROP.y0 && y < DROP.y1) raw[i] = 0;
    }
  }
  return { truth, raw };
}

describe('createCoverage: outer band', () => {
  it('grows a single pixel into exactly the Euclidean disc of COVERAGE_RADIUS', () => {
    const size = 41;
    const src = new Uint8Array(size * size);
    const c = 20;
    src[c * size + c] = 255;
    const out = run(size, size, src);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d2 = (x - c) ** 2 + (y - c) ** 2;
        expect(out[y * size + x] === 255, `pixel ${x},${y}`).toBe(d2 <= R * R);
      }
    }
  });

  it('never reaches farther than the radius from the original foreground', () => {
    const { raw } = fixture({ dropout: false });
    const out = run(W, H, raw);
    const fg = [];
    raw.forEach((v, i) => { if (v >= 128) fg.push([i % W, Math.floor(i / W)]); });
    for (let i = 0; i < out.length; i++) {
      if (out[i] < 128 || raw[i] >= 128) continue;
      const x = i % W;
      const y = Math.floor(i / W);
      const nearest = Math.min(...fg.map(([fx, fy]) => Math.hypot(fx - x, fy - y)));
      expect(nearest, `pixel ${x},${y}`).toBeLessThanOrEqual(R);
    }
  });

  it('keeps soft confidence values on the outside instead of thresholding them', () => {
    const size = 21;
    const src = new Uint8Array(size * size);
    src[10 * size + 10] = 90;
    const out = run(size, size, src);
    expect(out[10 * size + 10]).toBe(90);
    expect(out[10 * size + 14]).toBe(90); // distance R: inside the disc
    expect(out[10 * size + 15]).toBe(0); // distance R + 1: outside
  });

  it('does not wrap across the image edges', () => {
    const size = 30;
    const src = new Uint8Array(size * size);
    src[5 * size] = 255; // left column
    const out = run(size, size, src);
    for (let y = 0; y < size; y++) expect(out[y * size + size - 1]).toBe(0);
    expect(out[5 * size]).toBe(255);
  });

  it('is stateless between calls: reused buffers give the same result as a fresh instance', () => {
    const { raw } = fixture();
    const coverage = createCoverage(W, H);
    const first = new Uint8Array(W * H);
    const other = new Uint8Array(W * H);
    coverage.run(raw, first);
    coverage.run(new Uint8Array(W * H).fill(255), other);
    coverage.run(raw, other);
    expect(other).toEqual(first);
    expect(first).toEqual(run(W, H, raw));
  });

  it('keeps a fully solid mask fully solid', () => {
    const out = run(16, 12, new Uint8Array(16 * 12).fill(255));
    expect(out.every((v) => v === 255)).toBe(true);
  });
});

describe('createCoverage: enclosed holes', () => {
  it('closes the 2 px undercoverage ring and fills the enclosed dropout (synthetic fixture)', () => {
    const { truth, raw } = fixture();
    const dropIdx = (DROP.y0 + 6) * W + (DROP.x0 + 6);
    expect(raw[dropIdx]).toBe(0); // the dropout really is empty in the raw mask
    const out = run(W, H, raw);
    for (let y = DROP.y0; y < DROP.y1; y++) {
      for (let x = DROP.x0; x < DROP.x1; x++) expect(out[y * W + x]).toBe(255);
    }
    let missingBefore = 0;
    let missingAfter = 0;
    for (let i = 0; i < truth.length; i++) {
      if (!truth[i]) continue;
      if (raw[i] < 128) missingBefore++;
      if (out[i] < 128) missingAfter++;
    }
    expect(missingBefore).toBeGreaterThan(200);
    expect(missingAfter).toBe(0);
  });

  it('does not fill a large enclosed background', () => {
    const size = 70;
    const src = new Uint8Array(size * size);
    // A thin ring around a 51 x 51 background hole; the hole stays far above COVERAGE_MAX_HOLE.
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d = Math.max(Math.abs(x - 35), Math.abs(y - 35));
        if (d >= 26 && d <= 32) src[y * size + x] = 255;
      }
    }
    const out = run(size, size, src);
    expect(out[35 * size + 35]).toBe(0);
    expect(COVERAGE_MAX_HOLE).toBeLessThan(43 * 43);
  });

  it('does not fill a background notch that is open to the border', () => {
    const size = 40;
    const src = new Uint8Array(size * size);
    // Body from y = 5 down, with a 12 px notch reaching up to the top border. The notch is
    // enclosed on three sides but open at the top, so it is background, not a hole.
    for (let y = 5; y < size; y++) {
      for (let x = 5; x < 35; x++) {
        const notch = x >= 10 && x < 22 && y < 30;
        if (!notch) src[y * size + x] = 255;
      }
    }
    const out = run(size, size, src);
    expect(out[20 * size + 15]).toBe(0);
  });
});
