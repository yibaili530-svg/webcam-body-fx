import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createHandPredictor, motionGain, predictionFade, predictionHorizonMs, translateHand,
  PREDICT_LEAD_MAX, PREDICT_MAX_GAIN,
} from '../src/hand-predict.js';

// Synthetic fixture (not footage): a 1000 x 1000 frame so 1 px = 0.001 normalized and 1 short side = 1000 px.
// A hand is 21 identical points, so its centroid is the point itself.
const FRAME = { w: 1000, h: 1000 };
const hand = (cx, cy) => Array.from({ length: 21 }, () => ({ x: cx, y: cy, z: 0 }));
const sample = (seq, sampledAt, cx, cy) => ({ seq, sampledAt, hands: cx === null ? [] : [hand(cx, cy)] });

// Feed x = 0.50, 0.51, 0.52 at 10 ms steps. The two-sample smoothing settles the velocity at 0.75 px/ms
// by the third sample, with gain 0.65 (steady, straight, not slowing).
function steadyPredictor() {
  const p = createHandPredictor();
  p.observe(sample(1, 0, 0.5, 0.5), FRAME);
  p.observe(sample(2, 10, 0.51, 0.5), FRAME);
  p.observe(sample(3, 20, 0.52, 0.5), FRAME);
  return p;
}

describe('predictionHorizonMs', () => {
  it('is the sample age plus 20 ms, capped at 50 ms', () => {
    expect(predictionHorizonMs(0)).toBe(20);
    expect(predictionHorizonMs(10)).toBe(30);
    expect(predictionHorizonMs(30)).toBe(50);
    expect(predictionHorizonMs(500)).toBe(50);
  });

  it('treats a negative age as zero', () => {
    expect(predictionHorizonMs(-5)).toBe(20);
  });
});

describe('predictionFade', () => {
  it('is 1 up to 60 ms and 0 from 100 ms', () => {
    expect(predictionFade(0)).toBe(1);
    expect(predictionFade(60)).toBe(1);
    expect(predictionFade(100)).toBe(0);
    expect(predictionFade(101)).toBe(0);
  });

  it('fades linearly in between', () => {
    expect(predictionFade(80)).toBeCloseTo(0.5, 9);
    expect(predictionFade(70)).toBeCloseTo(0.75, 9);
  });

  it('is 0 for invalid ages', () => {
    expect(predictionFade(-1)).toBe(0);
    expect(predictionFade(Number.NaN)).toBe(0);
  });
});

describe('motionGain', () => {
  it('never exceeds the gain cap over a grid of speed, turn and deceleration', () => {
    for (let speed = 0; speed <= 2; speed += 0.05) {
      for (let cosTurn = -1; cosTurn <= 1; cosTurn += 0.05) {
        for (let decelRatio = 0; decelRatio <= 2; decelRatio += 0.05) {
          const g = motionGain({ speed, cosTurn, decelRatio });
          expect(g).toBeGreaterThanOrEqual(0);
          expect(g).toBeLessThanOrEqual(PREDICT_MAX_GAIN + 1e-12);
        }
      }
    }
    expect(PREDICT_MAX_GAIN).toBeLessThanOrEqual(0.65);
  });

  it('is 0 for a stopped or slow hand', () => {
    expect(motionGain({ speed: 0, cosTurn: 1, decelRatio: 1 })).toBe(0);
    expect(motionGain({ speed: 0.05, cosTurn: 1, decelRatio: 1 })).toBe(0);
  });

  it('is 0 on a sharp turn', () => {
    expect(motionGain({ speed: 1, cosTurn: 0, decelRatio: 1 })).toBe(0);
    expect(motionGain({ speed: 1, cosTurn: -1, decelRatio: 1 })).toBe(0);
  });

  it('is 0 on a hard stop (speed falls to half or less of the previous)', () => {
    expect(motionGain({ speed: 1, cosTurn: 1, decelRatio: 0.5 })).toBe(0);
    expect(motionGain({ speed: 1, cosTurn: 1, decelRatio: 0.2 })).toBe(0);
  });

  it('is at the cap for a fast, straight, steady hand', () => {
    expect(motionGain({ speed: 1, cosTurn: 1, decelRatio: 1 })).toBeCloseTo(PREDICT_MAX_GAIN, 9);
  });
});

describe('createHandPredictor: constant-velocity lead', () => {
  it('offsets by velocity x horizon x gain at zero age', () => {
    const p = steadyPredictor();
    const { offsets, horizonMs, gain } = p.predict(20);
    // horizon 20 ms, gain 0.65, velocity 0.75 px/ms -> 9.75 px.
    expect(horizonMs).toBe(20);
    expect(gain).toBeCloseTo(PREDICT_MAX_GAIN, 9);
    expect(offsets[0].dx).toBeCloseTo((0.75 * 20 * 0.65) / FRAME.w, 9);
    expect(offsets[0].dy).toBeCloseTo(0, 9);
  });

  it('grows with the sample age up to the 50 ms horizon', () => {
    const p = steadyPredictor();
    const at10 = p.predict(30).offsets[0].dx;
    expect(at10).toBeCloseTo((0.75 * 30 * 0.65) / FRAME.w, 9);
  });

  it('fades to half the lead at 80 ms', () => {
    const p = steadyPredictor();
    // Age 80 ms: horizon min(50, 80 + 20) = 50 ms, fade 0.5.
    const { offsets } = p.predict(100);
    expect(offsets[0].dx).toBeCloseTo((0.75 * 50 * 0.65 * 0.5) / FRAME.w, 9);
  });

  it('caps the lead at the lead limit of the short side', () => {
    // Big steps (100 px per 10 ms) push the velocity far above the cap at the 50 ms horizon.
    const p = createHandPredictor();
    p.observe(sample(1, 0, 0.1, 0.5), FRAME);
    p.observe(sample(2, 10, 0.2, 0.5), FRAME);
    p.observe(sample(3, 20, 0.3, 0.5), FRAME);
    const { offsets, leadPx } = p.predict(50);
    const cap = PREDICT_LEAD_MAX * FRAME.w;
    expect(leadPx).toBeCloseTo(cap, 9);
    expect(Math.hypot(offsets[0].dx * FRAME.w, offsets[0].dy * FRAME.h)).toBeLessThanOrEqual(cap + 1e-9);
  });

  it('predicts nothing beyond 100 ms of sample age', () => {
    const p = steadyPredictor();
    const r = p.predict(20 + 101);
    expect(r.horizonMs).toBe(0);
    expect(r.gain).toBe(0);
    expect(r.offsets.every((o) => o.dx === 0 && o.dy === 0)).toBe(true);
  });

  it('predicts nothing before any sample is observed', () => {
    const r = createHandPredictor().predict(0);
    expect(r.offsets).toEqual([]);
    expect(r.horizonMs).toBe(0);
  });
});

describe('createHandPredictor: dedup, identity and lost tracks', () => {
  it('ignores a sample whose seq is not greater than the last observed one', () => {
    const p = steadyPredictor();
    expect(p.observe(sample(3, 20, 0.52, 0.5), FRAME)).toBe(false);
    expect(p.observe(sample(2, 10, 0.51, 0.5), FRAME)).toBe(false);
  });

  it('resets velocity on an identity jump (a same-hand move beyond the jump limit)', () => {
    const p = steadyPredictor();
    // 170 px in one step: inside the match radius (0.2 short sides) but beyond the jump limit (0.15).
    p.observe(sample(4, 30, 0.69, 0.5), FRAME);
    expect(p.predict(30).offsets[0].dx).toBe(0);
  });

  it('resets velocity when the hand is lost and returns', () => {
    const p = steadyPredictor();
    p.observe(sample(4, 30, null, null), FRAME);
    p.observe(sample(5, 40, 0.52, 0.5), FRAME);
    expect(p.predict(40).offsets[0].dx).toBe(0);
  });

  it('does not extrapolate across a gap longer than 100 ms', () => {
    const p = steadyPredictor();
    p.observe(sample(4, 170, 0.53, 0.5), FRAME); // 150 ms after the last sample
    expect(p.predict(170).offsets[0].dx).toBe(0);
  });

  it('forgets every track on reset', () => {
    const p = steadyPredictor();
    p.reset();
    expect(p.predict(20).offsets).toEqual([]);
    p.observe(sample(4, 30, 0.53, 0.5), FRAME);
    expect(p.predict(30).offsets[0].dx).toBe(0);
  });
});

describe('translateHand', () => {
  it('returns the same hand when the offset is zero', () => {
    const h = hand(0.5, 0.5);
    expect(translateHand(h, 0, 0)).toBe(h);
  });

  it('moves every landmark by the offset without mutating the input', () => {
    const h = hand(0.5, 0.5);
    const moved = translateHand(h, 0.01, -0.02);
    expect(moved[0].x).toBeCloseTo(0.51, 9);
    expect(moved[0].y).toBeCloseTo(0.48, 9);
    expect(h[0].x).toBe(0.5);
    expect(h[0].y).toBe(0.5);
  });
});

describe('display-only contract', () => {
  it('gesture.js does not import the predictor, so gestures never read predicted hands', () => {
    const src = readFileSync(new URL('../src/gesture.js', import.meta.url), 'utf8');
    expect(src).not.toMatch(/hand-predict/);
    expect(readFileSync(new URL('../src/pinch.js', import.meta.url), 'utf8')).not.toMatch(/hand-predict/);
  });

  it('main.js observes the fresh sample and feeds the pinch detector the raw landmarks', () => {
    const src = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
    expect(src).toMatch(/pinch\.observe\(pinchSample, \{ w: video\.videoWidth, h: video\.videoHeight \}, now\)/);
    expect(src).toMatch(/s\.predictor\.observe\(hands,/);
    expect(src).not.toMatch(/handPoints/);
  });
});
