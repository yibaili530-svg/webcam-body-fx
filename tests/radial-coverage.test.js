import { describe, expect, it } from 'vitest';
import { COVERAGE_MAX_HOLE, COVERAGE_RADIUS, createCoverage } from '../src/coverage.js';
import { COMPOSITE_FRAG, MODE_INDEX } from '../src/view.js';

// Effects 3 (万花筒) and 4 (涟漪) gate on the processed coverage from coverage.js, plus the hand matte.
// Synthetic fixtures only (not footage): nothing here shows photographed-person accuracy or that a
// missing limb is recovered. The CPU mirror samples pixel centres (nearest). The shader samples the
// mask with a bicubic B-spline, so the two agree at pixel centres, not on sub-pixel edges.

const R = COVERAGE_RADIUS;
const W = 80;
const H = 60;
const UNDER = 2;
const TRUE_RX = 16;
const TRUE_RY = 24;
const DROP = { x0: 34, x1: 46, y0: 24, y1: 36 };
const inEllipse = (x, y, rx, ry) => ((x + 0.5 - 40) / rx) ** 2 + ((y + 0.5 - 30) / ry) ** 2 <= 1;

// Same body as coverage.test.js: `raw` is the truth shrunk by UNDER px, with a 12 x 12 dropout.
function fixture() {
  const truth = new Uint8Array(W * H);
  const raw = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (inEllipse(x, y, TRUE_RX, TRUE_RY)) truth[i] = 1;
      if (inEllipse(x, y, TRUE_RX - UNDER, TRUE_RY - UNDER)) raw[i] = 255;
      if (x >= DROP.x0 && x < DROP.x1 && y >= DROP.y0 && y < DROP.y1) raw[i] = 0;
    }
  }
  // Hand matte: a block far from the body. The matte is not expanded, so this is its only footprint.
  const matte = new Uint8Array(W * H);
  for (let y = 2; y < 7; y++) for (let x = 2; x < 7; x++) matte[y * W + x] = 255;
  return { truth, raw, matte };
}

// Processed coverage exactly as view.js setMask() produces it (same processor, same buffers).
const processOf = (w, h, raw) => {
  const out = new Uint8Array(w * h);
  createCoverage(w, h).run(raw, out);
  return out;
};

// CPU mirror of the processed gate for effects 3 and 4: conf = max(processed, matte) >= 0.5.
const gate = (processed, matte, x, y, w = W) => Math.max(processed[y * w + x], matte[y * w + x]) >= 128;
const rawGate = (raw, matte, x, y, w = W) => Math.max(raw[y * w + x], matte[y * w + x]) >= 128;

// Text of one mode branch of main(): from its `abs(uMode - N.0)` test up to the next branch.
function branchOf(idx) {
  const start = COMPOSITE_FRAG.indexOf(`abs(uMode - ${idx}.0) < 0.5`);
  const rest = COMPOSITE_FRAG.slice(start + 1);
  const end = rest.search(/abs\(uMode - /);
  return end < 0 ? rest : rest.slice(0, end);
}

describe('effects 3 and 4: exact shader routing to the processed mask', () => {
  for (const name of ['effect3', 'effect4']) {
    it(`${name} gates on uMask with the hand matte unioned, through the same crisp edge`, () => {
      const body = branchOf(MODE_INDEX[name]);
      expect(body).toMatch(/float region = crisp\(regionConf\(uMask, screen\)\);/);
      expect(body).not.toContain('uRawMask');
      const sampler = name === 'effect3' ? 'kaleidoscope(screen, t)' : 'ripples(screen)';
      expect(body).toContain(`col = mix(cam, ${sampler}, region);`);
    });
  }

  it('effect 1 keeps the processed mask, and effects 2 and 5 keep the raw one', () => {
    expect(branchOf(MODE_INDEX.effect1)).toContain('regionConf(uMask, screen)');
    expect(branchOf(MODE_INDEX.effect2)).toContain('regionConf(uRawMask, screen)');
    expect(branchOf(MODE_INDEX.effect5)).toContain('regionConf(uRawMask, screen)');
    expect(branchOf(MODE_INDEX.effect5)).not.toContain('uMask,');
  });
});

describe('effects 3 and 4: the processed gate, from the real createCoverage', () => {
  it('undercoverage: every true body pixel is inside the gate, where the raw gate misses some', () => {
    const { truth, raw, matte } = fixture();
    const processed = processOf(W, H, raw);
    let missingRaw = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!truth[y * W + x]) continue;
        expect(gate(processed, matte, x, y), `body pixel ${x},${y}`).toBe(true);
        if (!rawGate(raw, matte, x, y)) missingRaw++;
      }
    }
    expect(missingRaw).toBeGreaterThan(200);
  });

  it('holes: the enclosed dropout is inside the gate, though the raw gate has it as a hole', () => {
    const { raw, matte } = fixture();
    const processed = processOf(W, H, raw);
    for (let y = DROP.y0; y < DROP.y1; y++) {
      for (let x = DROP.x0; x < DROP.x1; x++) {
        expect(rawGate(raw, matte, x, y)).toBe(false);
        expect(gate(processed, matte, x, y)).toBe(true);
      }
    }
  });

  it('edge-clipped: a blob on the left border grows rightwards by R only, and never wraps', () => {
    const size = 30;
    const raw = new Uint8Array(size * size);
    for (let y = 10; y < 20; y++) for (let x = 0; x <= 3; x++) raw[y * size + x] = 255;
    const matte = new Uint8Array(size * size);
    const processed = processOf(size, size, raw);
    expect(gate(processed, matte, 3 + R, 14, size)).toBe(true); // R px past the edge of the blob
    expect(gate(processed, matte, 3 + R + 1, 14, size)).toBe(false); // one px more: outside
    for (let y = 0; y < size; y++) {
      expect(gate(processed, matte, size - 1, y, size), `right border row ${y}`).toBe(false);
    }
  });

  it('hand union: the matte is unioned as is, and is not dilated by the processed step', () => {
    const { raw, matte } = fixture();
    const processed = processOf(W, H, raw);
    // Inside the matte block: in the gate through the matte alone.
    expect(gate(processed, matte, 5, 5)).toBe(true);
    expect(processed[5 * W + 5]).toBe(0);
    // One pixel outside the matte block, far from the body: not in the gate. No dilation around hands.
    expect(gate(processed, matte, 7, 4)).toBe(false);
    expect(gate(processed, matte, 4, 7)).toBe(false);
  });

  it('no feather: the expansion of a binary mask is binary, so the gate edge is a hard step', () => {
    const { raw } = fixture();
    const processed = processOf(W, H, raw);
    for (const v of processed) expect(v === 0 || v === 255).toBe(true);
  });

  it('outside coverage: pixels more than R from the raw foreground stay out of the gate, except the filled dropout', () => {
    const { raw, matte } = fixture();
    const processed = processOf(W, H, raw);
    const fg = [];
    for (let i = 0; i < raw.length; i++) if (raw[i] >= 128) fg.push([i % W, Math.floor(i / W)]);
    const inDrop = (x, y) => x >= DROP.x0 && x < DROP.x1 && y >= DROP.y0 && y < DROP.y1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (matte[y * W + x] >= 128 || inDrop(x, y)) continue;
        const nearest = Math.min(...fg.map(([fx, fy]) => Math.hypot(fx - x, fy - y)));
        if (nearest > R) expect(gate(processed, matte, x, y), `pixel ${x},${y}`).toBe(false);
      }
    }
  });

  it('a background pocket above COVERAGE_MAX_HOLE stays out of the gate', () => {
    const size = 70;
    const raw = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d = Math.max(Math.abs(x - 35), Math.abs(y - 35));
        if (d >= 26 && d <= 32) raw[y * size + x] = 255;
      }
    }
    const matte = new Uint8Array(size * size);
    const processed = processOf(size, size, raw);
    expect(gate(processed, matte, 35, 35, size)).toBe(false);
    expect(COVERAGE_MAX_HOLE).toBeLessThan(43 * 43);
  });
});
