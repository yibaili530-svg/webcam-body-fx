// Freshness contract for hand observations. Pure: callers pass the clock, nothing reads it here.
//
// A hand sample is one completed hand-landmarker call: { seq, sampledAt, frameTime, hands }.
// - seq: strictly increasing across the whole page, so a sample can be recognised as new or replayed.
// - sampledAt: performance.now() when the call was invoked (inside the scheduled task), not when it was queued.
// - frameTime: video.currentTime of the frame that was drawn for the call.
// - hands: 21 source-space landmarks per hand.

/** Samples older than this are treated as absent. They are neither a hit nor an empty observation. */
export const HANDS_STALE_MS = 300;

/** The sample while it is fresh at `now`, otherwise null (also for a missing or NaN timestamp). */
export function freshHandSample(sample, now, maxAgeMs = HANDS_STALE_MS) {
  if (!sample) return null;
  return now - sample.sampledAt <= maxAgeMs ? sample : null;
}

/** Milliseconds since the sample was invoked, or Infinity when there is none. */
export function handSampleAgeMs(sample, now) {
  return sample ? now - sample.sampledAt : Infinity;
}
