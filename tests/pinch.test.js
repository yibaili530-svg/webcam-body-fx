import { describe, expect, it } from 'vitest';
import { createPinchDetector, PINCH_MIN_SCALE, pinchMeasure, predictRatio } from '../src/pinch.js';
import { HANDS_STALE_MS } from '../src/hand-sample.js';

const FRAME = { w: 1280, h: 720 };

// A hand in pixels: wrist at (cx, cy), middle MCP `scale` px straight above it, thumb and index
// tips `ratio * scale` apart and level with each other. Other landmarks sit on the wrist.
// Returned in normalized source coordinates, as the hand landmarker reports them.
function hand(ratio, { scale = 200, cx = 640, cy = 500, frame = FRAME } = {}) {
  const px = Array.from({ length: 21 }, () => ({ x: cx, y: cy }));
  px[9] = { x: cx, y: cy - scale };
  const d = (ratio * scale) / 2;
  px[4] = { x: cx - d, y: cy - scale * 0.6 };
  px[8] = { x: cx + d, y: cy - scale * 0.6 };
  return px.map((p) => ({ x: p.x / frame.w, y: p.y / frame.h }));
}

// A fresh sample. Its time stamp is the observation time unless `age` says otherwise.
let seq = 0;
const sample = (hands, at, age = 0) => ({ seq: ++seq, sampledAt: at - age, frameTime: 0, hands });

// Feeds ratios one per 33 ms and returns the event at each step (null when none).
function run(det, ratios, { start = 0, hands = (r) => [hand(r)], age = 0 } = {}) {
  return ratios.map((r, i) => {
    const at = start + i * 33;
    return det.observe(sample(hands(r), at, age), FRAME, at).event;
  });
}

describe('pinchMeasure (scale and aspect)', () => {
  it('reads the thumb-index distance over the wrist-to-middle-MCP scale', () => {
    expect(pinchMeasure(hand(0.4), FRAME).ratio).toBeCloseTo(0.4, 6);
  });

  it('gives the same ratio for a near (large) and a far (small) hand', () => {
    expect(pinchMeasure(hand(0.4, { scale: 320 }), FRAME).ratio).toBeCloseTo(0.4, 6);
    expect(pinchMeasure(hand(0.4, { scale: 90 }), FRAME).ratio).toBeCloseTo(0.4, 6);
  });

  it('is isotropic: the same physical hand gives the same ratio in a portrait frame', () => {
    const portrait = { w: 720, h: 1280 };
    const px = hand(0.4, { scale: 200, cx: 360, cy: 900, frame: portrait });
    expect(pinchMeasure(px, portrait).ratio).toBeCloseTo(0.4, 6);
  });

  it('refuses a hand whose scale is too small to trust, or with non-finite points', () => {
    const tiny = hand(0.4, { scale: PINCH_MIN_SCALE * 720 * 0.5 });
    expect(pinchMeasure(tiny, FRAME)).toBeNull();
    const bad = hand(0.4);
    bad[8] = { x: Number.NaN, y: 0.5 };
    expect(pinchMeasure(bad, FRAME)).toBeNull();
    expect(pinchMeasure(hand(0.4).slice(0, 10), FRAME)).toBeNull();
  });
});

describe('hysteresis: one event per touch, and a reopen is needed', () => {
  it('fires once on the close edge and not again while held closed', () => {
    const det = createPinchDetector();
    expect(run(det, [0.8, 0.7, 0.6, 0.2, 0.15, 0.1])).toEqual([null, null, null, 'close', null, null]);
  });

  it('does not fire on release', () => {
    const det = createPinchDetector();
    expect(run(det, [0.8, 0.2, 0.7, 0.9])).toEqual([null, 'close', null, null]);
  });

  it('a dip that stays above the close threshold is not a pinch', () => {
    const det = createPinchDetector();
    expect(run(det, [0.8, 0.4, 0.35, 0.4, 0.8])).toEqual([null, null, null, null, null]);
  });

  it('holding between the thresholds after a close does not re-fire; crossing open re-arms', () => {
    const det = createPinchDetector();
    // 0.4 is above close and below open: still counted as the same touch.
    expect(run(det, [0.8, 0.2, 0.4, 0.4, 0.4])).toEqual([null, 'close', null, null, null]);
    expect(run(det, [0.6, 0.2], { start: 200 })).toEqual([null, 'close']);
  });

  it('a hand that never opened first (fingers already together) does not fire', () => {
    const det = createPinchDetector();
    expect(run(det, [0.2, 0.15, 0.2])).toEqual([null, null, null]);
    expect(run(det, [0.7, 0.2], { start: 200 })).toEqual([null, 'close']);
  });
});

describe('prediction: early fire on an approaching, near-enough hand', () => {
  // Ratios drop about 0.13 per 33 ms (about 4 per second) and the sample is 60 ms old when observed:
  // the horizon is 50 ms, so the predicted lead is about 0.13 and carries the armed hand below CLOSE.
  it('fires early, before the real close sample arrives, and then stays closed', () => {
    const det = createPinchDetector();
    const events = [];
    // Open, then the thumb and index come in fast with the samples always 60 ms old.
    const ratios = [0.9, 0.77, 0.64, 0.49, 0.36, 0.23, 0.1];
    ratios.forEach((r, i) => {
      const at = i * 33;
      events.push(det.observe(sample([hand(r)], at, 60), FRAME, at).event);
    });
    expect(events.filter(Boolean)).toEqual(['early']);
    expect(events.indexOf('early')).toBeLessThan(ratios.indexOf(0.23));
  });

  it('does not fire for a near miss that decelerates and stops above the threshold', () => {
    const det = createPinchDetector();
    const events = run(det, [0.9, 0.7, 0.55, 0.47, 0.43, 0.41, 0.405, 0.405, 0.405], { age: 60 });
    expect(events.filter(Boolean)).toEqual([]);
  });

  it('a fast approach from far above the arming band does not fire early', () => {
    const det = createPinchDetector();
    // Open (not armed) and well above OPEN: no prediction may act here.
    const events = run(det, [0.95, 0.8, 0.65, 0.6], { age: 60 });
    expect(events.filter(Boolean)).toEqual([]);
  });

  it('predicts nothing when the sample is older than the prediction limit', () => {
    expect(predictRatio({ ratio: 0.4, velocity: -4, prevVelocity: -4, ageMs: 101 })).toBe(0.4);
  });

  it('predicts nothing when not approaching fast enough or when decelerating hard', () => {
    expect(predictRatio({ ratio: 0.4, velocity: -0.5, prevVelocity: -0.5, ageMs: 20 })).toBe(0.4);
    expect(predictRatio({ ratio: 0.4, velocity: -1, prevVelocity: -4, ageMs: 20 })).toBe(0.4);
  });

  it('caps the change a prediction may make', () => {
    const p = predictRatio({ ratio: 0.4, velocity: -100, prevVelocity: -100, ageMs: 60 });
    expect(p).toBeCloseTo(0.4 - 0.12, 6);
  });
});

describe('freshness and identity: stale, replayed and absent samples never fire', () => {
  it('ignores a stale sample (older than the stale limit) and does not consume its seq', () => {
    const det = createPinchDetector();
    run(det, [0.8]);
    const stale = { seq: 1000, sampledAt: 0, frameTime: 0, hands: [hand(0.2)] };
    expect(det.observe(stale, FRAME, HANDS_STALE_MS + 50).event).toBeNull();
  });

  it('ignores a sample whose seq is not greater than the last applied one', () => {
    const det = createPinchDetector();
    det.observe({ seq: 5, sampledAt: 0, frameTime: 0, hands: [hand(0.8)] }, FRAME, 0);
    expect(det.observe({ seq: 5, sampledAt: 33, frameTime: 0, hands: [hand(0.2)] }, FRAME, 33).event).toBeNull();
    expect(det.observe({ seq: 4, sampledAt: 33, frameTime: 0, hands: [hand(0.2)] }, FRAME, 33).event).toBeNull();
  });

  it('an absent hand (no hands in a fresh sample) never fires and resets that hand', () => {
    const det = createPinchDetector();
    run(det, [0.8, 0.2]); // one close, fired
    expect(run(det, [0.2], { hands: () => [] })).toEqual([null]);
    // Back with fingers together: the hand was lost, so it must be seen open before it can fire.
    expect(run(det, [0.2, 0.15], { start: 200 })).toEqual([null, null]);
  });

  it('a reacquired hand with fingers already together does not fire until it has been seen open', () => {
    const det = createPinchDetector();
    expect(run(det, [0.15, 0.1, 0.1])).toEqual([null, null, null]);
    expect(run(det, [0.8, 0.1], { start: 200 })).toEqual([null, 'close']);
  });

  it('a track not seen for longer than the stale limit starts again (no stale-state carry over)', () => {
    const det = createPinchDetector();
    det.observe(sample([hand(0.8)], 0), FRAME, 0);
    det.observe(sample([hand(0.2)], HANDS_STALE_MS + 100), FRAME, HANDS_STALE_MS + 100);
    expect(det.snapshot().state).toBe('unknown');
  });

  it('reset forgets every hand: the next close needs a fresh open first', () => {
    const det = createPinchDetector();
    run(det, [0.8]);
    det.reset();
    expect(run(det, [0.2], { start: 200 })).toEqual([null]);
  });
});

describe('refractory and multiple hands', () => {
  it('a second close within the refractory interval is not emitted as an event', () => {
    const det = createPinchDetector();
    expect(run(det, [0.8, 0.2])).toEqual([null, 'close']);
    // Opened and closed again 66 ms later: inside the refractory interval, so no event.
    expect(run(det, [0.8, 0.2], { start: 66 })).toEqual([null, null]);
  });

  it('two hands that close in the same sample count as one event', () => {
    const det = createPinchDetector();
    const two = (r) => [hand(r, { cx: 300 }), hand(r, { cx: 980 })];
    expect(run(det, [0.8, 0.2], { hands: two })).toEqual([null, 'close']);
  });

  it('either hand can pinch on its own, and each keeps its own state', () => {
    const det = createPinchDetector();
    const left = (r) => hand(r, { cx: 300 });
    const right = (r) => hand(r, { cx: 980 });
    expect(run(det, [0.8, 0.8], { hands: (r) => [left(r), right(0.8)] })).toEqual([null, null]);
    // Only the right hand closes, the left stays open.
    const events = run(det, [0.2], { start: 200, hands: () => [left(0.8), right(0.2)] });
    expect(events).toEqual(['close']);
  });
});
