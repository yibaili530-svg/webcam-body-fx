import { describe, expect, it } from 'vitest';
import { freshHandSample, handSampleAgeMs, HANDS_STALE_MS } from '../src/hand-sample.js';

const sample = (sampledAt, seq = 1) => ({ seq, sampledAt, frameTime: 0, hands: [] });

describe('freshHandSample', () => {
  it('keeps a sample up to the stale limit, inclusive', () => {
    const s = sample(1000);
    expect(freshHandSample(s, 1000)).toBe(s);
    expect(freshHandSample(s, 1000 + HANDS_STALE_MS)).toBe(s);
  });

  it('drops a sample just past the stale limit', () => {
    expect(freshHandSample(sample(1000), 1000 + HANDS_STALE_MS + 1)).toBeNull();
  });

  it('treats a missing sample, a never-stamped sample and a NaN stamp as absent', () => {
    expect(freshHandSample(null, 1000)).toBeNull();
    expect(freshHandSample(sample(-Infinity), 1000)).toBeNull();
    expect(freshHandSample(sample(Number.NaN), 1000)).toBeNull();
  });

  it('judges age from the invocation stamp, not from when a sample was read', () => {
    const s = sample(1000);
    expect(freshHandSample(s, 1200)).toBe(s); // read late, still fresh by its stamp
    expect(freshHandSample(s, 1301)).toBeNull(); // stamped long ago, stale even though just read
  });
});

describe('handSampleAgeMs', () => {
  it('is the time since invocation, or Infinity with no sample', () => {
    expect(handSampleAgeMs(sample(1000), 1250)).toBe(250);
    expect(handSampleAgeMs(null, 1250)).toBe(Infinity);
  });
});
