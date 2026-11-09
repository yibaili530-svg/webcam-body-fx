import { describe, expect, it } from 'vitest';
import { handDistance, handShapes, rasterizeHands, sampleMatte } from '../src/handmatte.js';
import { coverCrop, screenToSource, sourceToScreen } from '../src/mapping.js';
import { spreadHandLandmarks } from '../src/testmode.js';

const W = 320;
const H = 180;

// Spread hand, wrist at the origin, wrist -> middle MCP = 1 unit, fingers toward -y.
const TEMPLATE = [
  [0, 0],
  [-0.35, -0.2], [-0.65, -0.45], [-0.9, -0.7], [-1.1, -0.9],
  [-0.35, -0.95], [-0.5, -1.4], [-0.6, -1.7], [-0.7, -1.95],
  [0, -1], [0, -1.5], [0, -1.85], [0, -2.1],
  [0.3, -0.92], [0.45, -1.35], [0.55, -1.65], [0.62, -1.9],
  [0.55, -0.8], [0.8, -1.1], [0.95, -1.3], [1.05, -1.5],
];

/** Template point -> pixel, for a hand of `size` px at (cx, cy) px rotated by `angle`. */
const place = ([u, v], { cx, cy, size, angle = 0, flip = false }) => {
  const uu = flip ? -u : u;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: cx + size * (uu * c - v * s), y: cy + size * (uu * s + v * c) };
};
/** Normalized source landmarks for the placed template. */
const hand = (opts) => TEMPLATE.map((p) => {
  const q = place(p, opts);
  return { x: q.x / W, y: q.y / H };
});
const rasterize = (hands) => {
  const out = new Uint8Array(W * H);
  const any = rasterizeHands(hands, W, H, out);
  return { out, any, at: (px, py) => out[Math.floor(py) * W + Math.floor(px)] / 255 };
};
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const BASE = { cx: 160, cy: 150, size: 40 };

describe('handShapes', () => {
  it('scales radii with the hand size', () => {
    const small = handShapes(hand({ ...BASE, size: 20 }), W, H);
    const big = handShapes(hand({ ...BASE, size: 40 }), W, H);
    expect(big.size).toBeCloseTo(40);
    expect(small.size).toBeCloseTo(20);
    big.segments.forEach((s, i) => expect(s.ra).toBeCloseTo(2 * small.segments[i].ra));
  });

  it('tapers each finger toward the tip', () => {
    const { segments } = handShapes(hand(BASE), W, H);
    expect(segments).toHaveLength(15);
    for (let f = 0; f < 5; f++) {
      const chain = segments.slice(f * 3, f * 3 + 3);
      expect(chain[0].ra).toBeGreaterThan(chain[2].rb);
      chain.forEach((s) => expect(s.rb).toBeLessThan(s.ra));
    }
  });

  it('rejects missing, collapsed or non-finite hands', () => {
    expect(handShapes([], W, H)).toBeNull();
    expect(handShapes(Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5 })), W, H)).toBeNull();
    const bad = hand(BASE);
    bad[7] = { x: NaN, y: 0.5 };
    expect(handShapes(bad, W, H)).toBeNull();
  });
});

describe('rasterizeHands', () => {
  it('covers the palm and the fingertips', () => {
    const m = rasterize([hand(BASE)]);
    expect(m.any).toBe(true);
    const palm = place([0, -0.5], BASE);
    expect(m.at(palm.x, palm.y)).toBe(1);
    for (const tip of [4, 8, 12, 16, 20]) {
      const p = place(TEMPLATE[tip], BASE);
      expect(m.at(p.x, p.y)).toBeGreaterThan(0.5);
    }
  });

  it('leaves gaps between spread fingertips (no convex hull)', () => {
    const m = rasterize([hand(BASE)]);
    for (const [a, b] of [[8, 12], [12, 16], [16, 20], [4, 8]]) {
      const p = place(mid(TEMPLATE[a], TEMPLATE[b]), BASE);
      expect(m.at(p.x, p.y)).toBe(0);
    }
  });

  it('follows the landmark orientation and handedness', () => {
    const turned = { ...BASE, cx: 60, cy: 90, angle: Math.PI / 2 }; // fingers point +x
    const m = rasterize([hand(turned)]);
    const tip = place(TEMPLATE[12], turned);
    expect(tip.x).toBeGreaterThan(turned.cx + 70);
    expect(m.at(tip.x, tip.y)).toBeGreaterThan(0.5);
    // The upright pose's middle tip position is now empty.
    const upright = place(TEMPLATE[12], { ...BASE, cx: 60, cy: 90 });
    expect(m.at(upright.x, upright.y)).toBe(0);

    const left = { ...BASE, flip: true };
    const lm = rasterize([hand(left)]);
    const thumb = place(TEMPLATE[4], left);
    expect(thumb.x).toBeGreaterThan(BASE.cx);
    expect(lm.at(thumb.x, thumb.y)).toBeGreaterThan(0.5);
    const gap = place(mid(TEMPLATE[8], TEMPLATE[12]), left);
    expect(lm.at(gap.x, gap.y)).toBe(0);
  });

  it('has a soft edge', () => {
    const shapes = handShapes(hand(BASE), W, H);
    const out = new Uint8Array(W * H);
    rasterizeHands([hand(BASE)], W, H, out, 1);
    const values = new Set();
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const d = handDistance(shapes, x + 0.5, y + 0.5);
        if (Math.abs(d) < 0.5) values.add(out[y * W + x]);
      }
    }
    expect([...values].some((v) => v > 0 && v < 255)).toBe(true);
  });

  it('is empty with no hands and clears previous contents', () => {
    const out = new Uint8Array(W * H);
    rasterizeHands([hand(BASE)], W, H, out);
    expect(rasterizeHands([], W, H, out)).toBe(false);
    expect(out.every((v) => v === 0)).toBe(true);
  });

  it('clips hands partly or fully outside the raster', () => {
    const partial = rasterize([hand({ ...BASE, cx: -10, cy: 190 })]);
    expect(partial.out).toHaveLength(W * H);
    expect(partial.any).toBe(true);
    const gone = rasterize([hand({ ...BASE, cx: -500, cy: -500 })]);
    expect(gone.any).toBe(false);
    expect(gone.out.every((v) => v === 0)).toBe(true);
  });
});

describe('matte mapping', () => {
  it('lands under the hand on screen through the same crop and mirror as the mask', () => {
    const crop = coverCrop(1280, 720, 720, 1280); // portrait viewport crops the sides
    const opts = { cx: 0.6 * W, cy: 0.8 * H, size: 30 };
    const m = rasterize([hand(opts)]);
    const palmSrc = place([0, -0.5], opts);
    const palmScreen = sourceToScreen(palmSrc.x / W, palmSrc.y / H, crop);
    expect(palmScreen.x).toBeLessThan(0.5); // source right of center -> screen left

    // The compositor samples the matte at screenToSource(screen), like the person mask.
    const src = screenToSource(palmScreen.x, palmScreen.y, crop);
    expect(sampleMatte(m.out, W, H, src.x, src.y)).toBe(1);
    const mirrored = screenToSource(1 - palmScreen.x, palmScreen.y, crop);
    expect(sampleMatte(m.out, W, H, mirrored.x, mirrored.y)).toBe(0);
    expect(sampleMatte(m.out, W, H, -0.1, 0.5)).toBe(0);
  });
});

describe('test-mode silhouette fixture', () => {
  it('is a valid 21-point hand that rasterizes', () => {
    const lm = spreadHandLandmarks();
    expect(lm).toHaveLength(21);
    expect(rasterize([lm]).any).toBe(true);
  });
});
