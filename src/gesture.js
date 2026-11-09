// Effect target geometry. Hands no longer select anything from here: effects change by pinch
// (pinch.js, modes.js). The targets are invisible click and keyboard fallbacks, placed at the screen
// edges so manual selection keeps the same positions as before.

/** Target radius as a fraction of the viewport's short side, so circles stay round. */
export const TARGET_RADIUS = 0.07;

// Screen space: x right, y down, normalized to the viewport.
export const TARGETS = [
  { id: 'L-top', x: 0.08, y: 0.22, label: 'Fluid', mode: 'effect1', enabled: true },
  { id: 'L-mid', x: 0.08, y: 0.5, label: 'Slices', mode: 'effect2', enabled: true },
  { id: 'L-bottom', x: 0.08, y: 0.78, label: 'Kaleidoscope', mode: 'effect3', enabled: true },
  { id: 'R-top', x: 0.92, y: 0.22, label: 'Ripple', mode: 'effect4', enabled: true },
  { id: 'R-mid', x: 0.92, y: 0.5, label: 'Code', mode: 'effect5', enabled: true },
  { id: 'R-bottom', x: 0.92, y: 0.78, label: 'Cancel', mode: 'camera', enabled: true },
  { id: 'L-corner', x: 0.08, y: 0.07, label: 'Void', mode: 'effect6', enabled: true },
];

/** Target circle in screen pixels for a viewport of w x h. */
export function targetCircle(target, w, h) {
  return { cx: target.x * w, cy: target.y * h, r: TARGET_RADIUS * Math.min(w, h) };
}

/** Whether a normalized screen point lies inside the target's circle. */
export function pointInTarget(pt, target, w, h) {
  const { cx, cy, r } = targetCircle(target, w, h);
  return Math.hypot(pt.x * w - cx, pt.y * h - cy) <= r;
}
