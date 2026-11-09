import { describe, expect, it } from 'vitest';
import { maskCentroid, smoothAnchor } from '../src/anchor.js';

describe('maskCentroid', () => {
  it('returns null for an empty mask, so no anchor is taken from nothing', () => {
    expect(maskCentroid(new Uint8Array(16), 4, 4)).toBeNull();
  });

  it('returns the centre of a centred block, normalized to the mask', () => {
    const w = 8;
    const h = 6;
    const m = new Uint8Array(w * h);
    for (let y = 2; y < 4; y++) for (let x = 3; x < 5; x++) m[y * w + x] = 255;
    const c = maskCentroid(m, w, h);
    expect(c.x).toBeCloseTo(4 / w);
    expect(c.y).toBeCloseTo(3 / h);
  });

  it('ignores values below the 128 threshold', () => {
    const m = new Uint8Array(4);
    m[0] = 127;
    m[3] = 128;
    const c = maskCentroid(m, 2, 2);
    expect(c.x).toBeCloseTo(1.5 / 2);
    expect(c.y).toBeCloseTo(1.5 / 2);
  });
});

describe('smoothAnchor', () => {
  it('moves halfway with alpha 0.5 and stays finite', () => {
    const p = smoothAnchor({ x: 0, y: 0 }, { x: 1, y: 0.5 }, 0.5);
    expect(p).toEqual({ x: 0.5, y: 0.25 });
    expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
  });
});
