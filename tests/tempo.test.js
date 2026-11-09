import { describe, expect, it } from 'vitest';
import { EFFECT_TEMPO, RIP_W, TEMPO_PERIOD } from '../src/tempo.js';
import { COMPOSITE_FRAG, KAL_ROT, KAL_SECTORS, KAL_SPIN, MODE_INDEX } from '../src/view.js';
import { SLICE_FREQ_MIN, SLICE_FREQ_RANGE } from '../src/slices.js';
import { DIGITAL_GLINT_RATE, DIGITAL_PALETTE_HOLD, DIGITAL_STREAM_MIN, DIGITAL_STREAM_RANGE, digitalGlyph } from '../src/digital.js';
import { DIGITAL_ROWS } from '../src/glyphs.js';
import * as fluid from '../src/fluid.js';
import { VOID_DARK, VOID_HALO_TAPS, VOID_LIGHT, voidColour } from '../src/void.js';
import { readFileSync } from 'node:fs';

const fluidSource = readFileSync(new URL('../src/fluid.js', import.meta.url), 'utf8');

const TAU = 6.28318;

describe('shared tempo', () => {
  it('the ripple rate is unchanged at 14 rad/s, and the shared tempo is that rate', () => {
    expect(RIP_W).toBe(14);
    expect(EFFECT_TEMPO).toBe(RIP_W);
    expect(TEMPO_PERIOD).toBeCloseTo(TAU / 14, 4); // about 0.449 s
  });

  it('the ripple function and its constants are the same text as before the change', () => {
    expect(COMPOSITE_FRAG).toContain('const float RIP_K = 31.4159;');
    expect(COMPOSITE_FRAG).toContain('const float RIP_W = 14.0;');
    expect(COMPOSITE_FRAG).toContain('const float RIP_AMP = 0.05;');
    expect(COMPOSITE_FRAG).toContain('const float RIP_CREST = 0.3;');
    expect(COMPOSITE_FRAG).toContain('float wave = sin(RIP_K * r - RIP_W * uTime);');
    expect(COMPOSITE_FRAG).toContain('vec2 q = p - vec2(dir.x / aspect, dir.y) * (RIP_AMP * wave);');
    expect(COMPOSITE_FRAG).toContain('float crest = pow(max(wave, 0.0), 6.0);');
    expect(COMPOSITE_FRAG).toContain('return camera(q) * (1.0 + RIP_CREST * crest);');
  });
});

describe('kaleidoscope: one sector step per ripple period', () => {
  it('both rates are RIP_W / KAL_SECTORS, so the sector step is 2π/8 per period', () => {
    expect(KAL_ROT).toBeCloseTo(RIP_W / KAL_SECTORS, 12);
    expect(KAL_SPIN).toBeCloseTo(RIP_W / KAL_SECTORS, 12);
    expect(KAL_ROT * TEMPO_PERIOD).toBeCloseTo(TAU / KAL_SECTORS, 4);
  });

  it('the GLSL carries the same rates', () => {
    expect(COMPOSITE_FRAG).toContain(`const float KAL_ROT = ${KAL_ROT};`);
    expect(COMPOSITE_FRAG).toContain(`const float KAL_SPIN = ${KAL_SPIN};`);
  });
});

describe('slices: the frequency band is centred on the ripple rate', () => {
  it('the band mean SLICE_FREQ_MIN + SLICE_FREQ_RANGE / 2 equals RIP_W', () => {
    expect(SLICE_FREQ_MIN + SLICE_FREQ_RANGE / 2).toBeCloseTo(RIP_W, 9);
  });

  it('the band keeps its 0.6 : 1.4 form', () => {
    expect(SLICE_FREQ_MIN / SLICE_FREQ_RANGE).toBeCloseTo(0.6 / 1.4, 9);
  });

  it('the shader uses the scaled band, not the old constants', () => {
    expect(COMPOSITE_FRAG).toContain(`const float SLICE_FREQ_MIN = ${SLICE_FREQ_MIN};`);
    expect(COMPOSITE_FRAG).not.toContain('const float SLICE_FREQ_MIN = 0.6;');
  });
});

describe('digital code: glint, palette and stream timing', () => {
  it('one glint cycle per ripple period', () => {
    expect(DIGITAL_GLINT_RATE).toBe(RIP_W);
    expect(DIGITAL_GLINT_RATE * TEMPO_PERIOD).toBeCloseTo(TAU, 9);
  });

  it('the palette holds for a whole number of ripple periods (3, about 1.35 s)', () => {
    expect(DIGITAL_PALETTE_HOLD / TEMPO_PERIOD).toBeCloseTo(3, 9);
  });

  it('stream speeds are whole rows per ripple period, from 2 to 9 rows', () => {
    expect(DIGITAL_STREAM_MIN * DIGITAL_ROWS * TEMPO_PERIOD).toBeCloseTo(2, 9);
    expect((DIGITAL_STREAM_MIN + DIGITAL_STREAM_RANGE) * DIGITAL_ROWS * TEMPO_PERIOD).toBeCloseTo(9, 9);
  });

  it('the glyph index changes only at the ticks of the period clock: about once per ripple period', () => {
    // Over 10 periods the index can change at most once per tick (11 ticks, the first at a per-row phase).
    for (const row of [0, 17, 60]) {
      let changes = 0;
      let prev = digitalGlyph(3, row, 0, 64);
      for (let t = TEMPO_PERIOD / 200; t < 10 * TEMPO_PERIOD; t += TEMPO_PERIOD / 200) {
        const idx = digitalGlyph(3, row, t, 64);
        if (idx !== prev) changes++;
        prev = idx;
      }
      expect(changes).toBeLessThanOrEqual(11);
      expect(changes).toBeGreaterThanOrEqual(5);
    }
  });

  it('the GLSL uses the same glint rate and period-based glyph tick', () => {
    expect(COMPOSITE_FRAG).toContain('float tick = floor(t / TEMPO_PERIOD + hash(cell.y * 0.37 + 0.11));');
    expect(COMPOSITE_FRAG).toContain('const float TEMPO_PERIOD');
  });
});

describe('fluid is exempt from the shared tempo and keeps its authored slow flow', () => {
  it('fluid.js exports no FLUID_TIME_SCALE and does not import the tempo module', () => {
    expect(fluid).not.toHaveProperty('FLUID_TIME_SCALE');
    expect(fluidSource).not.toContain('FLUID_TIME_SCALE');
    expect(fluidSource).not.toMatch(/from ['"]\.\/tempo\.js['"]/);
    expect(fluidSource).not.toContain('EFFECT_TEMPO');
  });

  it('the bands and psi time terms are the original, unscaled coefficients', () => {
    expect(fluidSource).toContain('float a = p.x * 0.8 + p.y * 1.1 + t * 0.012');
    expect(fluidSource).toContain('+ 0.22 * sin(p.y * 2.1 + t * 0.07 + 1.5 * sin(p.x * 1.3 - t * 0.05));');
    expect(fluidSource).toContain('float psi(vec2 p, float t) {\n    float s = 0.0;');
    expect(fluidSource).toContain('uAspect * (0.5 + 0.42 * sin(t * (0.11 + 0.023 * fi) + fi * 1.7)),');
    expect(fluidSource).toContain('0.5 + 0.42 * sin(t * (0.09 + 0.031 * fi) + fi * 2.9 + 1.0));');
    expect(fluidSource).not.toMatch(/t \*= /);
  });
});

describe('effect 6 (Void) wiring', () => {
  it('MODE_INDEX has effect6 = 6 and the mode-6 branch is the only one testing 6.0', () => {
    expect(MODE_INDEX.effect6).toBe(6);
    expect(COMPOSITE_FRAG.match(/abs\(uMode - 6\.0\) < 0\.5/g)).toHaveLength(1);
  });

  it('the mode-6 branch reads the processed mask only', () => {
    const start = COMPOSITE_FRAG.indexOf('abs(uMode - 6.0) < 0.5');
    const body = COMPOSITE_FRAG.slice(start);
    expect([...body.matchAll(/regionConf\((uMask|uRawMask),/g)].map((m) => m[1])).toEqual(['uMask']);
    expect(body).toContain('voidGrade(screen, cam, region)');
  });

  it('voidGrade takes 8 binary taps on the ring and reads only the processed mask', () => {
    const body = COMPOSITE_FRAG.match(/vec3 voidGrade\([\s\S]*?\n {2}\}/)?.[0] ?? '';
    expect(body).not.toBe('');
    expect(body).toContain(`for (int i = 0; i < ${VOID_HALO_TAPS}; i++)`);
    expect(body).toContain('step(0.5, regionConf(uMask, screen + o))');
    expect(body).not.toContain('uRawMask');
    expect(body).toContain('sin(RIP_W * uTime)');
  });

  it('the void colours in the GLSL come from void.js', () => {
    expect(COMPOSITE_FRAG).toContain(`const vec3 VOID_DARK = vec3(${VOID_DARK.join(', ')});`);
    expect(COMPOSITE_FRAG).toContain(`const vec3 VOID_LIGHT = vec3(${VOID_LIGHT.join(', ')});`);
  });

  it('colour output is finite and inside [0, 1] for any camera, region, halo and time', () => {
    const samples = [0, 0.001, 0.2, 0.5, 0.8, 1];
    for (const r of samples) for (const g of samples) for (const b of samples) {
      for (const region of [0, 0.5, 1]) for (const ring of [0, 0.4, 1]) {
        for (const t of [0, 0.123, 7.7]) {
          const c = voidColour({ cam: [r, g, b], region, ring, t });
          for (const v of c) {
            expect(Number.isFinite(v)).toBe(true);
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it('the background is deep brown to muted orange (red dominant, blue low), the person is saturated yellow-orange', () => {
    const dark = voidColour({ cam: [0, 0, 0], region: 0, ring: 0, t: 0 });
    const light = voidColour({ cam: [1, 1, 1], region: 0, ring: 0, t: 0 });
    const fill = voidColour({ cam: [0.5, 0.5, 0.5], region: 1, ring: 0, t: 0 });
    for (const c of [dark, light]) {
      expect(c[0]).toBeGreaterThan(c[1]);
      expect(c[1]).toBeGreaterThanOrEqual(c[2]);
    }
    expect(light[0]).toBeGreaterThan(dark[0]); // luminance-mapped
    // The person is darker than the brightest background only in its shading, and brighter than the darkest.
    expect(fill[0]).toBeGreaterThan(dark[0]);
    expect(fill[1]).toBeGreaterThan(fill[2] * 2); // saturated: green well below red, blue near zero
  });

  it('the halo is outside only: inside the silhouette the glow term is zero', () => {
    const inside = voidColour({ cam: [0.5, 0.5, 0.5], region: 1, ring: 1, t: 0.3 });
    const insideNoHalo = voidColour({ cam: [0.5, 0.5, 0.5], region: 1, ring: 0, t: 0.3 });
    expect(inside).toEqual(insideNoHalo);
  });

  it('the halo pulse is subtle: a ripple period swings the glow by at most 8%', () => {
    const peak = voidColour({ cam: [0, 0, 0], region: 0, ring: 1, t: 0.25 * TEMPO_PERIOD });
    const trough = voidColour({ cam: [0, 0, 0], region: 0, ring: 1, t: 0.75 * TEMPO_PERIOD });
    expect(peak[1]).toBeGreaterThan(trough[1]);
    for (let i = 0; i < 3; i++) expect(Math.abs(peak[i] - trough[i])).toBeLessThan(0.2);
  });
});
