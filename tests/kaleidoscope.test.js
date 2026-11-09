import { describe, expect, it } from 'vitest';
import { COMPOSITE_FRAG, KAL_MAG, KAL_ROT, KAL_SECTORS, KAL_SPIN, KAL_SPIRAL } from '../src/view.js';

// Effect 3 (Kaleidoscope). JS mirror of the sampling in kaleidoscope() and reflectUnit() in COMPOSITE_FRAG.
// Distances are in screen-height units, as in the shader (x is scaled by the aspect first). The
// wiring tests at the top check that the GLSL text contains these same expressions, so the mirror
// and the shader cannot drift apart silently. Samples are not compared to pixels; this is the math.

const TAU = 6.28318; // the shader's literal
const SECTOR = TAU / KAL_SECTORS;
const LEGACY_ZOOM_MIN = 0.4; // the old 0.7 + 0.3 sin(...) pulse bottomed out here (2.5x magnification)

const mod = (x, y) => x - y * Math.floor(x / y);
const reflectUnit = (x) => 1 - Math.abs(1 - mod(x, 2));
// Mirror fold: 0 on the sector centreline, SECTOR / 2 on the seams.
const fold = (theta, t) => Math.abs(mod(theta + KAL_ROT * t, SECTOR) - 0.5 * SECTOR);

// Sample point before the edge reflection, screen space.
function kaleidoscopeRaw(p, t, aspect, anchor) {
  const dx = (p.x - anchor.x) * aspect;
  const dy = p.y - anchor.y;
  const r = Math.hypot(dx, dy);
  const theta = r < 1e-5 ? 0 : Math.atan2(dy, dx);
  const a = fold(theta, t) + KAL_SPIRAL * r + KAL_SPIN * t;
  const rs = r / KAL_MAG;
  return { x: anchor.x + (rs * Math.cos(a)) / aspect, y: anchor.y + rs * Math.sin(a) };
}

function kaleidoscopeSample(p, t, aspect, anchor) {
  const q = kaleidoscopeRaw(p, t, aspect, anchor);
  return { x: reflectUnit(q.x), y: reflectUnit(q.y) };
}

// Screen point at radius r (screen-height units) and angle theta about the anchor.
const polar = (r, theta, aspect, anchor) => ({
  x: anchor.x + (r * Math.cos(theta)) / aspect,
  y: anchor.y + r * Math.sin(theta),
});
const toHeight = (q, aspect, anchor) => ({ x: (q.x - anchor.x) * aspect, y: q.y - anchor.y });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

const ANCHOR = { x: 0.5, y: 0.5 };
const ASPECTS = [16 / 9, 9 / 16, 1]; // landscape, portrait, square
const TIMES = [0, 0.37, 1.9, 7.31, 42.5, 1e3];

describe('wiring: the shader text matches this mirror', () => {
  const body = COMPOSITE_FRAG.match(/vec3 kaleidoscope\(vec2 p, float t\) \{([\s\S]*?)\n {2}\}/)?.[1] ?? '';

  it('finds the kaleidoscope body', () => {
    expect(body).toContain('reflectUnit');
  });

  it('uses the same fold, spiral, spin and magnification expressions as the mirror', () => {
    for (const line of [
      'float sector = 6.28318 / KAL_SECTORS;',
      'float f = abs(mod(atan(dir.y, dir.x) + KAL_ROT * t, sector) - 0.5 * sector);',
      'float a = f + KAL_SPIRAL * r + KAL_SPIN * t;',
      'vec2 s = vec2(cos(a), sin(a)) * (r / KAL_MAG);',
      'return camera(vec2(reflectUnit(q.x), reflectUnit(q.y)));',
    ]) {
      expect(body).toContain(line);
    }
  });

  it('has no pulsing zoom and no clamped sampling left in the branch', () => {
    expect(body).not.toMatch(/zoom/);
    expect(body).not.toMatch(/clamp\(/);
  });

  it('defines the reflection and the generated constants', () => {
    expect(COMPOSITE_FRAG).toContain('float reflectUnit(float x) { return 1.0 - abs(1.0 - mod(x, 2.0)); }');
    expect(COMPOSITE_FRAG).toContain('const float KAL_MAG = 1.1;');
    expect(COMPOSITE_FRAG).toContain('const float KAL_SECTORS = 8.0;');
  });

  it('the mode 3 branch is gated by the processed coverage and mixed over the camera', () => {
    expect(COMPOSITE_FRAG).toMatch(
      /abs\(uMode - 3\.0\) < 0\.5\) \{[\s\S]*?float region = crisp\(regionConf\(uMask, screen\)\);\s*col = mix\(cam, kaleidoscope\(screen, t\), region\);/,
    );
  });
});

describe('8-fold radial mirror', () => {
  it('a rotation by one sector leaves the sample unchanged', () => {
    for (const aspect of ASPECTS) {
      for (const t of TIMES) {
        for (const r of [0.02, 0.1, 0.25, 0.4]) {
          for (let i = 0; i < 24; i++) {
            const theta = (i / 24) * TAU;
            const a = kaleidoscopeSample(polar(r, theta, aspect, ANCHOR), t, aspect, ANCHOR);
            const b = kaleidoscopeSample(polar(r, theta + SECTOR, aspect, ANCHOR), t, aspect, ANCHOR);
            // 1e-4: the atan branch cut and the shader's 6.28318 literal differ by ~5e-6 rad.
            expect(dist(a, b)).toBeLessThan(1e-4);
          }
        }
      }
    }
  });

  it('a point and its reflection about its sector centreline give the same sample', () => {
    for (const aspect of ASPECTS) {
      for (const t of TIMES) {
        for (let i = 0; i < 32; i++) {
          const r = 0.05 + 0.02 * i;
          const theta = (i / 32) * TAU;
          const phi = theta + KAL_ROT * t; // the angle the fold sees
          const k = Math.floor(phi / SECTOR);
          const centre = (k + 0.5) * SECTOR;
          const mirrored = 2 * centre - phi - KAL_ROT * t;
          const a = kaleidoscopeSample(polar(r, theta, aspect, ANCHOR), t, aspect, ANCHOR);
          const b = kaleidoscopeSample(polar(r, mirrored, aspect, ANCHOR), t, aspect, ANCHOR);
          expect(dist(a, b)).toBeLessThan(1e-4);
        }
      }
    }
  });

  it('the fold is continuous at every seam, with a peak (cusp) there and zero on the centreline', () => {
    const d = 1e-6;
    for (const t of TIMES) {
      const at = (phi) => fold(phi - KAL_ROT * t, t);
      for (let k = 0; k < KAL_SECTORS; k++) {
        const seam = k * SECTOR;
        expect(at(seam - d)).toBeCloseTo(0.5 * SECTOR - d, 9);
        expect(at(seam + d)).toBeCloseTo(0.5 * SECTOR - d, 9);
        expect(at(seam + 0.5 * SECTOR)).toBeCloseTo(0, 9);
      }
    }
  });

  it('samples are continuous across every seam', () => {
    const d = 1e-6;
    for (const aspect of ASPECTS) {
      for (const t of TIMES) {
        for (let k = 0; k < KAL_SECTORS; k++) {
          for (const r of [0.1, 0.3]) {
            const phi = k * SECTOR;
            const left = kaleidoscopeSample(polar(r, phi - d - KAL_ROT * t, aspect, ANCHOR), t, aspect, ANCHOR);
            const right = kaleidoscopeSample(polar(r, phi + d - KAL_ROT * t, aspect, ANCHOR), t, aspect, ANCHOR);
            expect(dist(left, right)).toBeLessThan(1e-4);
          }
        }
      }
    }
  });

  it('is finite at the centre and continuous into it', () => {
    for (const aspect of ASPECTS) {
      for (const t of TIMES) {
        const q0 = kaleidoscopeSample(ANCHOR, t, aspect, ANCHOR);
        expect(dist(q0, ANCHOR)).toBeLessThan(1e-12);
        for (const r of [1e-3, 1e-5, 1e-7]) {
          const q = kaleidoscopeSample(polar(r, 0.3, aspect, ANCHOR), t, aspect, ANCHOR);
          expect(Number.isFinite(q.x) && Number.isFinite(q.y)).toBe(true);
          const h = toHeight(q, aspect, ANCHOR);
          expect(Math.hypot(h.x, h.y)).toBeLessThanOrEqual(r / KAL_MAG + 1e-12);
        }
      }
    }
  });
});

describe('constant ~1.1x magnification, aspect-correct', () => {
  it('the magnification is 1.1x, not the old 2.5x peak of the zoom pulse', () => {
    expect(KAL_MAG).toBeGreaterThanOrEqual(1.05);
    expect(KAL_MAG).toBeLessThanOrEqual(1.12);
    expect(KAL_MAG).toBeLessThan((1 / LEGACY_ZOOM_MIN) / 2);
  });

  it('the sample radius is r / KAL_MAG in screen-height units, in landscape, portrait and square', () => {
    for (const aspect of ASPECTS) {
      for (const t of TIMES) {
        for (const r of [0.05, 0.1, 0.2, 0.3]) {
          for (let i = 0; i < 16; i++) {
            const q = kaleidoscopeRaw(polar(r, (i / 16) * TAU, aspect, ANCHOR), t, aspect, ANCHOR);
            const h = toHeight(q, aspect, ANCHOR);
            expect(Math.hypot(h.x, h.y)).toBeCloseTo(r / KAL_MAG, 9);
          }
        }
      }
    }
  });

  it('the magnification never reaches 1:1 at any time, so there is no full-normal phase', () => {
    for (const t of [...TIMES, 0.5, 2.5, 99]) {
      const q = kaleidoscopeRaw(polar(0.2, 1.0, 16 / 9, ANCHOR), t, 16 / 9, ANCHOR);
      const h = toHeight(q, 16 / 9, ANCHOR);
      const ratio = Math.hypot(h.x, h.y) / 0.2;
      expect(ratio).toBeCloseTo(1 / KAL_MAG, 9);
      expect(Math.abs(ratio - 1)).toBeGreaterThan(0.05);
    }
  });
});

describe('time continuity and edge handling', () => {
  it('moves continuously in time: no jump between frames', () => {
    let worst = 0;
    for (const aspect of ASPECTS) {
      for (const r of [0.1, 0.3, 0.5]) {
        for (let i = 0; i < 8; i++) {
          const p = polar(r, (i / 8) * TAU, aspect, ANCHOR);
          let prev = kaleidoscopeSample(p, 0, aspect, ANCHOR);
          for (let t = 1 / 240; t <= 20; t += 1 / 240) {
            const cur = kaleidoscopeSample(p, t, aspect, ANCHOR);
            worst = Math.max(worst, dist(prev, cur));
            prev = cur;
          }
        }
      }
    }
    // Angular speed is at most KAL_ROT + KAL_SPIN (3.5 rad/s, one sector step per ripple period). At 1/240 s
    // the largest step scales with that speed: the bound was 0.01 at the old sum of 1.0 rad/s.
    expect(worst).toBeLessThan(0.01 * (KAL_ROT + KAL_SPIN));
  });

  it('reflects samples past the frame edge: bounded, continuous, and never a clamped strip', () => {
    let worst = 0;
    let prev = reflectUnit(-3);
    for (let x = -3; x <= 3; x += 0.001) {
      const y = reflectUnit(x);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(1);
      worst = Math.max(worst, Math.abs(y - prev));
      prev = y;
    }
    expect(worst).toBeLessThan(0.0011);
    expect(reflectUnit(1.05)).toBeCloseTo(0.95, 9);
    expect(reflectUnit(-0.05)).toBeCloseTo(0.05, 9);
    expect(reflectUnit(1.01)).not.toBe(reflectUnit(1.02));
  });

  it('a circle of samples that crosses the frame edge and the atan branch cut stays continuous', () => {
    for (const aspect of ASPECTS) {
      for (const t of TIMES) {
        for (const r of [0.3, 0.6, 0.9]) {
          let worst = 0;
          let prev = kaleidoscopeSample(polar(r, 0, aspect, ANCHOR), t, aspect, ANCHOR);
          for (let i = 1; i <= 4000; i++) {
            const cur = kaleidoscopeSample(polar(r, (i / 4000) * TAU, aspect, ANCHOR), t, aspect, ANCHOR);
            worst = Math.max(worst, dist(prev, cur));
            prev = cur;
          }
          expect(worst).toBeLessThan(0.005);
        }
      }
    }
  });
});
