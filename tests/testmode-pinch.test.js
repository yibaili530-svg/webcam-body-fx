import { describe, expect, it } from 'vitest';
import { PINCH_SCRIPTS, pinchHandLandmarks, pinchRatioAt } from '../src/testmode.js';
import { createPinchDetector, pinchMeasure } from '../src/pinch.js';
import { createModeController } from '../src/modes.js';
import { HANDS_STALE_MS } from '../src/hand-sample.js';

const FRAME = { w: 1280, h: 720 };
const STEP_MS = 33;

// Runs one SYNTHETIC script at detector cadence through the real detector and mode controller.
function runScript(name, durationMs = 2000) {
  const det = createPinchDetector();
  const modes = createModeController();
  const events = [];
  const keys = PINCH_SCRIPTS[name];
  let seq = 0;
  for (let t = 0; t <= durationMs; t += STEP_MS) {
    const hands = keys ? [pinchHandLandmarks(pinchRatioAt(keys, t))] : [];
    const result = det.observe({ seq: ++seq, sampledAt: t, frameTime: 0, hands }, FRAME, t);
    if (result.event) events.push({ t, kind: result.event, mode: modes.pinch(t).mode });
  }
  return { events, final: modes.mode() };
}

describe('pinchRatioAt (script timelines)', () => {
  it('interpolates linearly between keyframes and holds the ends', () => {
    const keys = [[0, 0.9], [100, 0.1]];
    expect(pinchRatioAt(keys, -50)).toBe(0.9);
    expect(pinchRatioAt(keys, 50)).toBeCloseTo(0.5, 6);
    expect(pinchRatioAt(keys, 500)).toBe(0.1);
  });
});

describe('synthetic hand geometry goes through the real measure', () => {
  it('the ratio of the built hand is the ratio asked for, in both scales', () => {
    expect(pinchMeasure(pinchHandLandmarks(0.2), FRAME).ratio).toBeCloseTo(0.2, 6);
    expect(pinchMeasure(pinchHandLandmarks(0.8), FRAME).ratio).toBeCloseTo(0.8, 6);
  });
});

describe('SYNTHETIC scripts through the real detector and mode path', () => {
  it('a single pinch fires one event and enters the first effect', () => {
    const { events, final } = runScript('single');
    expect(events.map((e) => e.mode)).toEqual(['effect1']);
    expect(final).toBe('effect1');
  });

  it('a double pinch fires two events, and the second cancels back to camera', () => {
    const { events, final } = runScript('double');
    expect(events.map((e) => e.mode)).toEqual(['effect1', 'camera']);
    expect(final).toBe('camera');
  });

  it('the near miss approaches and stops above the close threshold: no event at all', () => {
    const { events, final } = runScript('near');
    expect(events).toEqual([]);
    expect(final).toBe('camera');
  });

  it('a slow pinch fires exactly one event, not an early one before the real close', () => {
    const { events } = runScript('slow');
    expect(events.map((e) => e.mode)).toEqual(['effect1']);
  });

  it('an open hand and no hand both fire nothing', () => {
    expect(runScript('open').events).toEqual([]);
    expect(runScript('none').events).toEqual([]);
  });

  it('a stale synthetic sample is not a pinch: the freshness rule applies to scripts too', () => {
    const det = createPinchDetector();
    const hands = [pinchHandLandmarks(0.1)];
    expect(det.observe({ seq: 1, sampledAt: 0, frameTime: 0, hands }, FRAME, HANDS_STALE_MS + 1).event).toBeNull();
  });
});
