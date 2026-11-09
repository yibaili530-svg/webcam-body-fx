import { describe, expect, it } from 'vitest';
import { createModeController, CYCLE, DOUBLE_WINDOW_MS, nextMode } from '../src/modes.js';

describe('cycle order', () => {
  it('goes effect1 -> ... -> effect5 -> effect6 -> effect1', () => {
    expect(CYCLE).toEqual(['effect1', 'effect2', 'effect3', 'effect4', 'effect5', 'effect6']);
    expect(nextMode('effect1')).toBe('effect2');
    expect(nextMode('effect4')).toBe('effect5');
    expect(nextMode('effect5')).toBe('effect6');
    expect(nextMode('effect6')).toBe('effect1');
  });

  it('from camera (or any unknown mode) the next pinch enters effect1', () => {
    expect(nextMode('camera')).toBe('effect1');
    expect(nextMode('nonsense')).toBe('effect1');
  });

  it('single pinches walk the whole cycle in order, starting from camera', () => {
    const m = createModeController();
    const modes = [];
    for (let i = 0; i < 7; i++) modes.push(m.pinch(i * 1000).mode);
    expect(modes).toEqual(['effect1', 'effect2', 'effect3', 'effect4', 'effect5', 'effect6', 'effect1']);
  });

  it('a double pinch returns to camera from every effect', () => {
    for (const target of CYCLE) {
      const m = createModeController();
      let now = 0;
      while (m.mode() !== target) { m.pinch(now); now += 1000; }
      // The double starts at `now`: its first pinch moves on to the next effect, the second cancels.
      expect(m.pinch(now).action).toBe('next');
      expect(m.pinch(now + DOUBLE_WINDOW_MS - 10)).toEqual({ action: 'cancel', mode: 'camera' });
      expect(m.mode()).toBe('camera');
    }
  });
});

describe('single pinch and double pinch', () => {
  it('a single pinch reports next and changes the mode at once', () => {
    const m = createModeController();
    expect(m.pinch(0)).toEqual({ action: 'next', mode: 'effect1' });
    expect(m.mode()).toBe('effect1');
  });

  it('two pinches inside the window cancel to camera', () => {
    const m = createModeController();
    m.pinch(0);
    expect(m.pinch(DOUBLE_WINDOW_MS - 10)).toEqual({ action: 'cancel', mode: 'camera' });
    expect(m.mode()).toBe('camera');
  });

  it('a double from camera: the first pinch enters effect1, the second cancels back to camera', () => {
    const m = createModeController();
    expect(m.pinch(0).mode).toBe('effect1');
    expect(m.pinch(200).mode).toBe('camera');
  });

  it('a double from a later effect cancels to camera, not to the previous effect', () => {
    const m = createModeController();
    m.pinch(0);
    m.pinch(1000); // effect2
    expect(m.pinch(1200)).toEqual({ action: 'cancel', mode: 'camera' });
  });

  it('two pinches outside the window are two nexts', () => {
    const m = createModeController();
    expect(m.pinch(0).mode).toBe('effect1');
    expect(m.pinch(DOUBLE_WINDOW_MS + 1).mode).toBe('effect2');
  });

  it('a pinch exactly at the window edge still counts as the second half of a double', () => {
    const m = createModeController();
    m.pinch(0);
    expect(m.pinch(DOUBLE_WINDOW_MS).action).toBe('cancel');
  });

  it('after a cancel, the next pinch starts fresh: it is a next, not a double', () => {
    const m = createModeController();
    m.pinch(0);
    m.pinch(100); // cancel
    expect(m.pinch(200)).toEqual({ action: 'next', mode: 'effect1' });
    // And a close follow-up after that is a new double, measured from the new first pinch.
    expect(m.pinch(300).action).toBe('cancel');
  });

  it('the window is measured from the first pinch, not from the previous one', () => {
    const m = createModeController();
    m.pinch(0); // effect1
    m.pinch(DOUBLE_WINDOW_MS + 1); // effect2: a next, and it starts a new pending pinch
    expect(m.pinch(DOUBLE_WINDOW_MS + 100).action).toBe('cancel');
  });
});

describe('manual select, reset and camera changes', () => {
  it('a manual select ends a pending double: the next pinch is not a cancel', () => {
    const m = createModeController();
    m.pinch(0); // effect1
    expect(m.select('effect3')).toBe(true);
    expect(m.pinch(100)).toEqual({ action: 'next', mode: 'effect4' });
  });

  it('a manual select returns true once and false when repeated or unknown', () => {
    const m = createModeController();
    expect(m.select('effect4')).toBe(true);
    expect(m.select('effect4')).toBe(false);
    expect(m.select('bogus')).toBe(false);
    expect(m.mode()).toBe('effect4');
    expect(m.select('camera')).toBe(true);
    expect(m.mode()).toBe('camera');
  });

  it('reset returns to camera and ends any pending double', () => {
    const m = createModeController();
    m.pinch(0);
    m.reset();
    expect(m.mode()).toBe('camera');
    expect(m.pinch(100)).toEqual({ action: 'next', mode: 'effect1' });
  });

  it('invalidate keeps the mode but cannot complete a double from the old feed', () => {
    const m = createModeController();
    m.pinch(0); // effect1
    m.invalidate();
    expect(m.mode()).toBe('effect1');
    expect(m.pinch(100)).toEqual({ action: 'next', mode: 'effect2' });
  });
});
