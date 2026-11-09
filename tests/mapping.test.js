import { describe, expect, it } from 'vitest';
import { coverCrop, screenToSource, sourceToScreen } from '../src/mapping.js';

const FULL = { x: 0, y: 0, w: 1, h: 1 };

describe('coverCrop', () => {
  it('is the full frame when aspects match', () => {
    expect(coverCrop(1280, 720, 640, 360)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('crops the sides on a narrower viewport', () => {
    const c = coverCrop(1280, 720, 720, 1280);
    expect(c.w).toBeCloseTo((720 / 1280) / (1280 / 720));
    expect(c.x).toBeCloseTo((1 - c.w) / 2);
    expect([c.y, c.h]).toEqual([0, 1]);
  });

  it('crops top and bottom on a wider viewport', () => {
    const c = coverCrop(1280, 720, 2000, 500);
    expect(c.h).toBeCloseTo((1280 / 720) / 4);
    expect(c.y).toBeCloseTo((1 - c.h) / 2);
    expect([c.x, c.w]).toEqual([0, 1]);
  });

  it('falls back to the full frame before video metadata is known', () => {
    expect(coverCrop(0, 0, 800, 600)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});

describe('screen <-> source', () => {
  it('mirrors x and keeps y', () => {
    expect(screenToSource(0, 0, FULL)).toEqual({ x: 1, y: 0 });
    expect(screenToSource(1, 1, FULL)).toEqual({ x: 0, y: 1 });
    expect(sourceToScreen(0.8, 0.25, FULL).x).toBeCloseTo(0.2);
    expect(sourceToScreen(0.8, 0.25, FULL).y).toBeCloseTo(0.25);
  });

  it('round-trips through a crop', () => {
    const crop = coverCrop(1280, 720, 720, 1280);
    const src = screenToSource(0.3, 0.7, crop);
    const back = sourceToScreen(src.x, src.y, crop);
    expect(back.x).toBeCloseTo(0.3);
    expect(back.y).toBeCloseTo(0.7);
  });

  it('stays within the crop rectangle', () => {
    const crop = coverCrop(1280, 720, 720, 1280);
    expect(screenToSource(1, 0, crop).x).toBeCloseTo(crop.x);
    expect(screenToSource(0, 0, crop).x).toBeCloseTo(crop.x + crop.w);
  });
});
