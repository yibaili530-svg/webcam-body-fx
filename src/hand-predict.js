// Display-only motion prediction for the hand matte. Pure: callers pass the clock and the frame size.
//
// The predictor watches consecutive FRESH hand samples (one per hand-landmarker call) and estimates
// each hand's velocity from its 21-point centroid. Each render frame it offsets the matte landmarks by
// a constant-velocity lead, so the matte shows where the hand is going rather than where it was.
//
// Contract:
// - Gesture selection never reads anything from here. It uses the real fresh samples only.
// - Nothing predicted is stored. Only observed centroids and velocities are kept, and they are
//   dropped on any identity jump, lost track, stale sample or input reset.
// - Lead = velocity x horizon x gain, where horizon = min(50 ms, sample age + 20 ms) and
//   gain <= 0.65. The lead is capped at a fraction of the short side.
// - Prediction is zero when the sample is older than 100 ms. It fades to zero between 60 and 100 ms,
//   so the matte does not snap when the cut-off arrives.

/** Samples older than this predict nothing. */
export const PREDICT_MAX_AGE_MS = 100;
/** The lead fades out from PREDICT_FADE_START_MS to PREDICT_MAX_AGE_MS. */
export const PREDICT_FADE_START_MS = 60;
/** Display delay that is added to the sample age, so the lead lands near the displayed time. */
export const PREDICT_EXTRA_MS = 20;
/** Largest horizon, however old the sample is. */
export const PREDICT_HORIZON_MS = 50;
/** Largest gain, even for a steady fast hand. */
export const PREDICT_MAX_GAIN = 0.65;
/** Largest lead, as a fraction of the frame's short side. */
export const PREDICT_LEAD_MAX = 0.02;
/** A centroid this far (fraction of the short side) from the last one still belongs to the same hand. */
export const PREDICT_MATCH = 0.2;
/** A same-hand move this large between two samples is an identity jump: velocity is reset. */
export const PREDICT_JUMP = 0.15;
/** Velocity is only estimated from two samples at most this far apart. */
export const PREDICT_MAX_GAP_MS = 100;
// Damping ranges. Speeds are in short sides per second.
const SPEED_LO = 0.1;
const SPEED_HI = 0.5;
const TURN_COS_HI = 0.9;
const DECEL_FLOOR = 0.5;

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Constant-velocity horizon in ms for a sample of the given age. */
export function predictionHorizonMs(ageMs) {
  return Math.min(PREDICT_HORIZON_MS, Math.max(0, ageMs) + PREDICT_EXTRA_MS);
}

/** Fraction of the lead kept at this sample age: 1 up to 60 ms, a linear fade, 0 from 100 ms. */
export function predictionFade(ageMs) {
  if (!(ageMs >= 0) || ageMs > PREDICT_MAX_AGE_MS) return 0;
  if (ageMs <= PREDICT_FADE_START_MS) return 1;
  return (PREDICT_MAX_AGE_MS - ageMs) / (PREDICT_MAX_AGE_MS - PREDICT_FADE_START_MS);
}

/**
 * Gain in [0, PREDICT_MAX_GAIN] for one hand's motion. `speed` is short sides per second, `cosTurn`
 * the cosine between the previous and current velocity (1 = straight), `decelRatio` the ratio of the
 * current speed to the previous one (below 1 = slowing down). A stopped or slow hand gets 0, a sharp
 * turn gets 0, and a hard stop gets 0.
 */
export function motionGain({ speed = 0, cosTurn = 1, decelRatio = 1 } = {}) {
  const speedF = smooth(SPEED_LO, SPEED_HI, speed);
  const turnF = smooth(0, TURN_COS_HI, cosTurn);
  const decelF = decelRatio >= 1 ? 1 : clamp01((decelRatio - DECEL_FLOOR) / (1 - DECEL_FLOOR));
  return PREDICT_MAX_GAIN * speedF * turnF * decelF;
}

/** Normalized centroid of a hand's 21 source-space landmarks, in pixels of the frame. */
function centroidPx(hand, frame) {
  let x = 0;
  let y = 0;
  for (const p of hand) {
    x += p.x;
    y += p.y;
  }
  return { x: (x / hand.length) * frame.w, y: (y / hand.length) * frame.h };
}

const ZERO = { dx: 0, dy: 0 };

/**
 * Returns `{ observe(sample, frame), predict(now), reset() }`.
 * - observe: call with each FRESH sample { seq, sampledAt, hands } and the video frame size
 *   { w, h }. A sample whose seq is not greater than the last one observed is ignored.
 * - predict(now): `{ offsets, horizonMs, leadPx, gain }`. `offsets[i]` is the normalized (dx, dy) to add
 *   to every landmark of hand i in the latest observed sample. All zero when nothing applies.
 * - reset(): forget every track (camera switch, stop). The next observed sample starts fresh.
 */
export function createHandPredictor() {
  let lastSeq = -Infinity;
  let tracks = [];
  // Motion for the latest observed sample, aligned with its hands. Never a prediction.
  let current = { sampledAt: -Infinity, frame: null, motions: [] };

  function observe(sample, frame) {
    if (!sample || !(sample.seq > lastSeq) || !(frame?.w > 0 && frame?.h > 0)) return false;
    lastSeq = sample.seq;
    const short = Math.min(frame.w, frame.h);
    const used = new Array(tracks.length).fill(false);
    const nextTracks = [];
    const motions = [];

    for (const hand of sample.hands) {
      const c = centroidPx(hand, frame);
      let best = -1;
      let bestD = Infinity;
      for (let j = 0; j < tracks.length; j++) {
        if (used[j]) continue;
        const d = Math.hypot(c.x - tracks[j].x, c.y - tracks[j].y);
        if (d < bestD && d <= PREDICT_MATCH * short) {
          best = j;
          bestD = d;
        }
      }
      const prev = best >= 0 ? tracks[best] : null;
      if (prev) used[best] = true;
      const dt = prev ? sample.sampledAt - prev.t : 0;
      const continuous = prev && dt > 0 && dt <= PREDICT_MAX_GAP_MS && bestD <= PREDICT_JUMP * short;

      if (!continuous) {
        // New, lost-and-returned, or jumped: a fresh track with no velocity, so no prediction.
        nextTracks.push({ x: c.x, y: c.y, t: sample.sampledAt, vx: 0, vy: 0 });
        motions.push({ vx: 0, vy: 0, gain: 0 });
        continue;
      }

      // Light smoothing of the two-sample estimate, so landmark jitter does not become velocity.
      const rawVx = (c.x - prev.x) / dt;
      const rawVy = (c.y - prev.y) / dt;
      const vx = 0.5 * rawVx + 0.5 * prev.vx;
      const vy = 0.5 * rawVy + 0.5 * prev.vy;
      const speed = (Math.hypot(vx, vy) * 1000) / short;
      const prevSpeed = Math.hypot(prev.vx, prev.vy);
      const nowSpeed = Math.hypot(vx, vy);
      const cosTurn = prevSpeed > 0 && nowSpeed > 0 ? (vx * prev.vx + vy * prev.vy) / (nowSpeed * prevSpeed) : 1;
      const decelRatio = prevSpeed > 0 ? nowSpeed / prevSpeed : 1;
      nextTracks.push({ x: c.x, y: c.y, t: sample.sampledAt, vx, vy });
      motions.push({ vx, vy, gain: motionGain({ speed, cosTurn, decelRatio }) });
    }

    tracks = nextTracks;
    current = { sampledAt: sample.sampledAt, frame: { w: frame.w, h: frame.h }, motions };
    return true;
  }

  function predict(now) {
    const { motions, frame, sampledAt } = current;
    const age = now - sampledAt;
    const fade = predictionFade(age);
    if (!(fade > 0) || !frame) {
      return { offsets: motions.map(() => ZERO), horizonMs: 0, leadPx: 0, gain: 0 };
    }
    const horizon = predictionHorizonMs(age);
    const cap = PREDICT_LEAD_MAX * Math.min(frame.w, frame.h);
    let leadPx = 0;
    let gain = 0;
    const offsets = motions.map((m) => {
      if (!(m.gain > 0)) return ZERO;
      const k = horizon * m.gain * fade;
      let dx = m.vx * k;
      let dy = m.vy * k;
      const d = Math.hypot(dx, dy);
      if (d > cap) {
        dx *= cap / d;
        dy *= cap / d;
      }
      const lead = Math.min(d, cap);
      leadPx = Math.max(leadPx, lead);
      gain = Math.max(gain, m.gain * fade);
      return { dx: dx / frame.w, dy: dy / frame.h };
    });
    return { offsets, horizonMs: horizon, leadPx, gain };
  }

  function reset() {
    tracks = [];
    current = { sampledAt: -Infinity, frame: null, motions: [] };
  }

  return { observe, predict, reset };
}

/** Returns a copy of one hand with every landmark moved by the normalized offset. */
export function translateHand(hand, dx, dy) {
  if (dx === 0 && dy === 0) return hand;
  return hand.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy }));
}
