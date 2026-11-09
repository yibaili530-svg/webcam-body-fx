import { describe, expect, it } from 'vitest';
import { pointInTarget, TARGET_RADIUS, TARGETS, targetCircle } from '../src/gesture.js';
import { MODE_INDEX } from '../src/view.js';

const SIZE = { w: 1000, h: 1000 };
const center = (id) => {
  const t = TARGETS.find((target) => target.id === id);
  return { x: t.x, y: t.y };
};

describe('targets (manual fallback geometry)', () => {
  it('enables all seven targets, each mapped to a distinct shader mode', () => {
    expect(TARGETS.map((t) => t.id)).toEqual(['L-top', 'L-mid', 'L-bottom', 'R-top', 'R-mid', 'R-bottom', 'L-corner']);
    expect(TARGETS.every((t) => t.enabled)).toBe(true);
    expect(TARGETS.map((t) => t.mode)).toEqual(['effect1', 'effect2', 'effect3', 'effect4', 'effect5', 'camera', 'effect6']);
    expect(new Set(TARGETS.map((t) => t.mode)).size).toBe(7);
  });

  it('no two fallback circles overlap, and each lies inside the viewport, in landscape and portrait', () => {
    for (const [w, h] of [[1920, 1080], [1080, 1920], [1000, 1000]]) {
      const circles = TARGETS.map((t) => targetCircle(t, w, h));
      circles.forEach((c) => {
        expect(c.cx - c.r).toBeGreaterThanOrEqual(-1e-9);
        expect(c.cx + c.r).toBeLessThanOrEqual(w + 1e-9);
        expect(c.cy - c.r).toBeGreaterThanOrEqual(-1e-9);
        expect(c.cy + c.r).toBeLessThanOrEqual(h + 1e-9);
      });
      for (let i = 0; i < circles.length; i++) {
        for (let j = i + 1; j < circles.length; j++) {
          const d = Math.hypot(circles[i].cx - circles[j].cx, circles[i].cy - circles[j].cy);
          expect(d).toBeGreaterThan(circles[i].r + circles[j].r);
        }
      }
    }
  });

  it('maps every mode to a shader index, so each target reaches its branch', () => {
    for (const t of TARGETS) expect(MODE_INDEX[t.mode]).toBeTypeOf('number');
    expect(new Set(Object.values(MODE_INDEX)).size).toBe(Object.keys(MODE_INDEX).length);
  });

  it('has no zone-hand selection left: gesture.js exports no hand path', async () => {
    const gestureModule = await import('../src/gesture.js');
    expect(gestureModule).not.toHaveProperty('handTarget');
    expect(gestureModule).not.toHaveProperty('createGesture');
  });

  it('a target circle is centred on its position with the radius from the short side', () => {
    const c = targetCircle(TARGETS[0], 1000, 500);
    expect(c.cx).toBeCloseTo(80);
    expect(c.cy).toBeCloseTo(110);
    expect(c.r).toBeCloseTo(TARGET_RADIUS * 500);
  });

  it('a point is inside its own target and outside a far one', () => {
    expect(pointInTarget(center('R-mid'), TARGETS.find((t) => t.id === 'R-mid'), SIZE.w, SIZE.h)).toBe(true);
    expect(pointInTarget(center('R-mid'), TARGETS.find((t) => t.id === 'L-top'), SIZE.w, SIZE.h)).toBe(false);
  });
});
