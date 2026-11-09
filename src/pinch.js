// Pure thumb-index pinch detector. No DOM and no clock: callers pass `now` and the frame size.
//
// Input is the source-space hand landmarks of one FRESH hand sample (see hand-sample.js), 21 points
// per hand, normalized to the frame. Output is at most one event per sample: 'close' when a hand's
// thumb and index come together, or 'early' when the same close is predicted from an approaching
// hand a moment before it lands. Events never fire on release.
//
// Distance is thumb tip (4) to index tip (8), divided by the hand scale (wrist 0 to middle MCP 9), so
// it does not depend on how far the hand is from the camera. Points are scaled to pixels first, so the
// distance is isotropic whatever the video aspect. Mirroring does not change distances.

import { freshHandSample, HANDS_STALE_MS } from './hand-sample.js';

/** Distance ratio below which a hand counts as pinched. Estimated from hand proportions, not measured. */
export const PINCH_CLOSE = 0.3;
/** Distance ratio above which a hand counts as open again. Hysteresis: must exceed PINCH_CLOSE. */
export const PINCH_OPEN = 0.5;
/** Minimum time between two events from the detector (all hands). Shorter than the double-pinch window. */
export const PINCH_REFRACTORY_MS = 140;
/** Hand scale below this fraction of the frame's short side is treated as an invalid hand. */
export const PINCH_MIN_SCALE = 0.05;
/** A hand matches its track when its wrist moved less than this fraction of the short side. */
export const PINCH_MATCH = 0.25;

// Early fire: a prediction, damped and capped. Speeds are in scale ratios per second.
/** Predictions are used only while the sample is at most this old. */
export const PINCH_PREDICT_MAX_AGE_MS = 100;
/** Horizon is min(this, sample age + PINCH_PREDICT_EXTRA_MS). */
export const PINCH_PREDICT_HORIZON_MS = 50;
export const PINCH_PREDICT_EXTRA_MS = 20;
/** Largest gain on the velocity. */
export const PINCH_PREDICT_GAIN = 0.65;
/** Approach speed (ratio per second) below which the hand counts as not approaching. */
export const PINCH_APPROACH_MIN = 1.0;
/** Largest change a prediction may make to the distance ratio. */
export const PINCH_PREDICT_CAP = 0.12;

const hypot = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Distance ratio and wrist point for one hand, in pixels, or null when the hand cannot be measured
 * (non-finite points, or a hand scale too small to trust).
 */
export function pinchMeasure(hand, frame) {
  if (!hand || hand.length < 21) return null;
  const px = (i) => ({ x: hand[i].x * frame.w, y: hand[i].y * frame.h });
  const points = [0, 4, 8, 9].map(px);
  if (!points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return null;
  const [wrist, thumb, index, middle] = points;
  const scale = hypot(wrist, middle);
  if (!(scale >= PINCH_MIN_SCALE * Math.min(frame.w, frame.h))) return null;
  return { ratio: hypot(thumb, index) / scale, wrist };
}

/**
 * Predicted distance ratio `horizon` ms ahead. Zero (no change) unless the hand is approaching fast
 * enough, is not stopping hard, and the sample is fresh enough. The change is capped.
 */
export function predictRatio({ ratio, velocity, prevVelocity, ageMs }) {
  if (!(ageMs >= 0) || ageMs > PINCH_PREDICT_MAX_AGE_MS) return ratio;
  if (!(velocity < -PINCH_APPROACH_MIN)) return ratio;
  // Strong deceleration: the approach is slowing by more than half, so the lead is not trusted.
  if (prevVelocity < 0 && velocity / prevVelocity < 0.5) return ratio;
  const horizon = Math.min(PINCH_PREDICT_HORIZON_MS, Math.max(0, ageMs) + PINCH_PREDICT_EXTRA_MS);
  const change = velocity * (horizon / 1000) * PINCH_PREDICT_GAIN;
  return ratio + Math.max(-PINCH_PREDICT_CAP, Math.min(PINCH_PREDICT_CAP, change));
}

const NONE = Object.freeze({ event: null, ratio: null, predicted: null, velocity: 0, state: 'unknown' });

/**
 * Returns `{ observe(sample, frame, now), reset(), snapshot() }`.
 * - observe: call with each hand sample { seq, sampledAt, hands } and the frame size { w, h }. A sample
 *   that is stale (see freshHandSample), not newer by seq, or measured with an invalid hand does not
 *   fire. Returns `{ event, ratio, predicted, velocity, state }`; event is null, 'close' or 'early'.
 * - Per hand state: 'unknown' (disarmed: needs an observed open hand first), 'open', 'armed' (below
 *   PINCH_OPEN, so a close may be predicted), 'closed' (fired; waits for PINCH_OPEN again).
 * - A hand that is not seen in a fresh sample is dropped, so its state returns to 'unknown'.
 */
export function createPinchDetector() {
  let lastSeq = -Infinity;
  let lastEventAt = -Infinity;
  let tracks = [];
  let last = NONE;

  // Advances one hand's state with one observation. Returns 'close', 'early' or null.
  function step(track, ratio, predicted, now) {
    if (track.state === 'unknown') {
      if (ratio >= PINCH_OPEN) track.state = 'open';
      return null;
    }
    if (track.state === 'closed') {
      if (ratio >= PINCH_OPEN) track.state = 'open';
      return null;
    }
    if (track.state === 'open') {
      if (ratio < PINCH_CLOSE) {
        track.state = 'closed';
        return 'close';
      }
      if (ratio < PINCH_OPEN) track.state = 'armed';
      return null;
    }
    // armed
    if (ratio < PINCH_CLOSE) {
      track.state = 'closed';
      return 'close';
    }
    if (ratio >= PINCH_OPEN) {
      track.state = 'open';
      return null;
    }
    if (predicted < PINCH_CLOSE) {
      // The real close has not arrived yet. Counted as closed, so the real close does not fire again.
      track.state = 'closed';
      return 'early';
    }
    return null;
  }

  function observe(sample, frame, now) {
    if (!sample || !(sample.seq > lastSeq) || !freshHandSample(sample, now)) return NONE;
    if (!(frame?.w > 0 && frame?.h > 0)) return NONE;
    lastSeq = sample.seq;
    const short = Math.min(frame.w, frame.h);
    const ageMs = now - sample.sampledAt;

    const measured = sample.hands.map((hand) => pinchMeasure(hand, frame));
    const used = new Array(tracks.length).fill(false);
    const nextTracks = [];
    let event = null;
    let primary = null;

    for (const m of measured) {
      if (!m) continue;
      let best = -1;
      let bestD = PINCH_MATCH * short;
      for (let j = 0; j < tracks.length; j++) {
        if (used[j]) continue;
        const d = Math.hypot(m.wrist.x - tracks[j].x, m.wrist.y - tracks[j].y);
        if (d <= bestD) {
          best = j;
          bestD = d;
        }
      }
      const prev = best >= 0 ? tracks[best] : null;
      if (prev) used[best] = true;
      // A track whose last fresh sample is too old starts again: no state carries over a gap.
      const continuous = prev && sample.sampledAt - prev.t <= HANDS_STALE_MS;
      const track = continuous
        ? { ...prev }
        : { state: 'unknown', velocity: 0, prevVelocity: 0 };

      const dtS = continuous ? (sample.sampledAt - prev.t) / 1000 : 0;
      if (continuous && dtS > 0 && dtS * 1000 <= PINCH_PREDICT_MAX_AGE_MS) {
        const raw = (m.ratio - prev.ratio) / dtS;
        track.prevVelocity = prev.velocity;
        track.velocity = 0.5 * raw + 0.5 * prev.velocity;
      } else {
        track.prevVelocity = 0;
        track.velocity = 0;
      }
      track.ratio = m.ratio;
      track.t = sample.sampledAt;
      track.x = m.wrist.x;
      track.y = m.wrist.y;

      const predicted = predictRatio({
        ratio: m.ratio,
        velocity: track.velocity,
        prevVelocity: track.prevVelocity,
        ageMs,
      });
      const fired = step(track, m.ratio, predicted, now);
      if (fired === 'early' || (fired === 'close' && event !== 'early')) event = fired;
      nextTracks.push(track);
      if (!primary || m.ratio < primary.ratio) primary = { ...track, predicted };
    }

    tracks = nextTracks;
    if (event && now - lastEventAt < PINCH_REFRACTORY_MS) event = null;
    if (event) lastEventAt = now;
    last = primary
      ? { event, ratio: primary.ratio, predicted: primary.predicted, velocity: primary.velocity, state: primary.state }
      : { ...NONE, event };
    return last;
  }

  function reset() {
    tracks = [];
    lastEventAt = -Infinity;
    last = NONE;
  }

  return {
    observe,
    reset,
    snapshot: () => last,
    /** Milliseconds until another event may be emitted (0 when none is held back). */
    cooldownMs: (now) => Math.max(0, PINCH_REFRACTORY_MS - (now - lastEventAt)),
  };
}
