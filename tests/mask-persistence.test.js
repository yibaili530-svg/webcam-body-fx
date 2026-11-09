import { describe, expect, it } from 'vitest';
import { createMaskPersistence, PERSIST_HOLD_MS, PERSIST_SOLID } from '../src/mask-persistence.js';

// Synthetic fixture (not footage): a 40 x 30 mask with a solid 20 x 20 body and a 3 px dropout disc.
const W = 40;
const H = 30;
const BODY = { x0: 10, x1: 30, y0: 5, y1: 25 };
const DISC = { cx: 20, cy: 15, r: 3 };

function body(shift = 0) {
  const raw = new Uint8Array(W * H);
  for (let y = BODY.y0; y < BODY.y1; y++) {
    for (let x = BODY.x0 + shift; x < BODY.x1 + shift; x++) if (x >= 0 && x < W) raw[y * W + x] = 255;
  }
  return raw;
}

function withDropout(raw) {
  const out = raw.slice();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if ((x + 0.5 - DISC.cx) ** 2 + (y + 0.5 - DISC.cy) ** 2 < DISC.r * DISC.r) out[y * W + x] = 0;
    }
  }
  return out;
}

const at = (out, x, y) => out[y * W + x];
const discPixels = () => {
  const list = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if ((x + 0.5 - DISC.cx) ** 2 + (y + 0.5 - DISC.cy) ** 2 < DISC.r * DISC.r) list.push([x, y]);
    }
  }
  return list;
};

describe('createMaskPersistence: enclosed dropouts', () => {
  it('holds an enclosed dropout at the solid contour or above while within the hold window', () => {
    const p = createMaskPersistence(W, H);
    const out = new Uint8Array(W * H);
    p.update(body(), 0, out);
    const dropped = withDropout(body());
    p.update(dropped, 33, out);
    for (const [x, y] of discPixels()) {
      expect(at(out, x, y)).toBeGreaterThanOrEqual(PERSIST_SOLID);
    }
    expect(p.heldPx).toBe(discPixels().length);
  });

  it('expires hard at the hold limit, using result timestamps and not frame counts', () => {
    const p = createMaskPersistence(W, H);
    const out = new Uint8Array(W * H);
    p.update(body(), 0, out);
    // Same dropout, held at the boundary (inclusive), then expired one millisecond later.
    p.update(withDropout(body()), PERSIST_HOLD_MS, out);
    expect(at(out, DISC.cx, DISC.cy)).toBeGreaterThanOrEqual(PERSIST_SOLID);
    p.update(withDropout(body()), PERSIST_HOLD_MS + 1, out);
    expect(at(out, DISC.cx, DISC.cy)).toBe(0);
    expect(p.heldPx).toBe(0);
  });

  it('does not hold across a long real gap: only the clock matters, not how many updates ran', () => {
    const p = createMaskPersistence(W, H);
    const out = new Uint8Array(W * H);
    p.update(body(), 0, out);
    // One update, 500 ms later: the strong value is far too old to hold.
    p.update(withDropout(body()), 500, out);
    expect(at(out, DISC.cx, DISC.cy)).toBe(0);
  });

  it('never lowers the raw value and never holds a pixel that was never seen', () => {
    const p = createMaskPersistence(W, H);
    const out = new Uint8Array(W * H);
    const raw = withDropout(body());
    p.update(raw, 0, out);
    for (let i = 0; i < raw.length; i++) expect(out[i]).toBeGreaterThanOrEqual(raw[i]);
    expect(p.heldPx).toBe(0);
    expect(out).toEqual(raw);
  });

  it('closes the held value towards the contour, never below it, over the window', () => {
    const p = createMaskPersistence(W, H);
    const out = new Uint8Array(W * H);
    p.update(body(), 0, out);
    let previous = 256;
    for (let t = 10; t <= PERSIST_HOLD_MS; t += 10) {
      p.update(withDropout(body()), t, out);
      const v = at(out, DISC.cx, DISC.cy);
      expect(v).toBeGreaterThanOrEqual(PERSIST_SOLID);
      expect(v).toBeLessThanOrEqual(previous);
      previous = v;
    }
  });
});

describe('createMaskPersistence: no ghost trail', () => {
  it('does not hold the trailing edge of a moving person (not enclosed by present pixels)', () => {
    const p = createMaskPersistence(W, H);
    const out = new Uint8Array(W * H);
    p.update(body(0), 0, out);
    // The person moves 6 px right. The columns it left are open background on the left side.
    const moved = body(6);
    p.update(moved, 33, out);
    for (let y = BODY.y0; y < BODY.y1; y++) {
      for (let x = BODY.x0; x < BODY.x0 + 6; x++) expect(at(out, x, y)).toBe(0);
    }
    expect(p.heldPx).toBe(0);
  });

  it('holds nothing farther than the enclosure radius from the present silhouette', () => {
    const p = createMaskPersistence(W, H);
    const out = new Uint8Array(W * H);
    const solidBody = body();
    p.update(solidBody, 0, out);
    // Remove a 12-px-wide strip: wider than 2 * PERSIST_ENCLOSE, so the middle cannot be enclosed.
    const gap = solidBody.slice();
    for (let y = BODY.y0; y < BODY.y1; y++) for (let x = 14; x < 26; x++) gap[y * W + x] = 0;
    p.update(gap, 33, out);
    expect(at(out, 20, 15)).toBe(0);
  });
});

describe('createMaskPersistence: raw path and reset', () => {
  it('leaves the input array untouched and adds no dilation when nothing drops out', () => {
    const p = createMaskPersistence(W, H);
    const out = new Uint8Array(W * H);
    const raw = body();
    const before = raw.slice();
    p.update(raw, 0, out);
    p.update(raw, 33, out);
    expect(raw).toEqual(before);
    expect(out).toEqual(raw);
  });

  it('reset forgets every strong value: a later dropout is not held', () => {
    const p = createMaskPersistence(W, H);
    const out = new Uint8Array(W * H);
    p.update(body(), 0, out);
    p.reset();
    p.update(withDropout(body()), 33, out);
    expect(at(out, DISC.cx, DISC.cy)).toBe(0);
    expect(p.heldPx).toBe(0);
  });
});
