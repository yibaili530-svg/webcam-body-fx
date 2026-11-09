// Effect mode controller for pinch events. Pure: callers pass the time of each pinch.
//
// - A pinch moves to the next effect in CYCLE. From camera (or 取消) the first pinch enters effect1.
// - A second pinch within DOUBLE_WINDOW_MS of the first cancels: the mode goes back to camera.
//   The first switch is shown for up to the window before that cancel (see README).
// - After a cancel, the next pinch starts fresh: it is a 'next', not a second half of a double.
// - A click (manual select) or reset is not a pinch and ends any pending double.

/** Cycle order of the effects. The camera is not in the cycle: a pinch from camera enters effect1. */
export const CYCLE = ['effect1', 'effect2', 'effect3', 'effect4', 'effect5', 'effect6'];

/**
 * Window after the first pinch in which a second pinch cancels. Longer than PINCH_REFRACTORY_MS, so
 * a jittery double-close of one pinch cannot cancel by itself. Shorter than a deliberate second tap.
 */
export const DOUBLE_WINDOW_MS = 350;

/** The effect after `mode` in the cycle. Camera and any unknown mode enter effect1. */
export function nextMode(mode) {
  const i = CYCLE.indexOf(mode);
  return i < 0 ? CYCLE[0] : CYCLE[(i + 1) % CYCLE.length];
}

/**
 * Returns `{ pinch(now), select(mode), reset(), invalidate(), mode(), snapshot() }`.
 * pinch(now) returns `{ action: 'next' | 'cancel', mode }` and changes the mode.
 */
export function createModeController() {
  let mode = 'camera';
  // Time of the first pinch of a pending double, or null when no pinch is pending.
  let pendingAt = null;

  return {
    pinch(now) {
      if (pendingAt !== null && now - pendingAt <= DOUBLE_WINDOW_MS) {
        mode = 'camera';
        pendingAt = null;
        return { action: 'cancel', mode };
      }
      mode = nextMode(mode);
      pendingAt = now;
      return { action: 'next', mode };
    },
    /** Manual select (click, keyboard). Returns whether the mode changed. Ends any pending double. */
    select(next) {
      pendingAt = null;
      if (next === mode || (!CYCLE.includes(next) && next !== 'camera')) return false;
      mode = next;
      return true;
    },
    reset() {
      mode = 'camera';
      pendingAt = null;
    },
    /** Camera input changed: the mode is kept, but no pinch from the old feed can complete a double. */
    invalidate() {
      pendingAt = null;
    },
    mode: () => mode,
    snapshot: () => ({ mode, pendingAt }),
  };
}
