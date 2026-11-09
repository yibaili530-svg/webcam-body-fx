// Effect 6 (Void) look: constants shared with the GLSL (view.js injects them) and a JS mirror of
// voidGrade() in COMPOSITE_FRAG. Display-referred RGB; the shader squares it to linear, as the fluid does.
// The whole frame is graded: the background is the camera luminance mapped from deep brown to muted
// orange, and the person is a near-flat saturated fill with a warm halo just outside its edge.

import { RIP_W } from './tempo.js';

export const VOID_DARK = [0.1, 0.04, 0.01]; // background at the darkest camera luminance: deep brown
export const VOID_LIGHT = [0.55, 0.28, 0.08]; // background at the brightest: muted orange
export const VOID_FILL = [1.0, 0.62, 0.12]; // the person: saturated yellow-orange, near flat
export const VOID_GLOW = [1.0, 0.55, 0.12]; // halo just outside the silhouette edge
export const VOID_HALO_R = 0.03; // halo ring radius, in screen heights (8 binary taps on the ring)
export const VOID_HALO_TAPS = 8;
export const VOID_PULSE = 0.08; // halo brightness swings by this share, at the ripple rate RIP_W

const mix = (a, b, t) => a + (b - a) * t;

/**
 * Display-referred colour of one pixel of effect 6, as voidGrade() computes it. `cam` is the linear camera
 * RGB, `region` the antialiased silhouette (0..1), `ring` the share of halo taps inside the mask (0..1), and
 * `t` the time in seconds. Returns linear RGB (display squared), each channel in [0, 1].
 */
export function voidColour({ cam, region, ring, t }) {
  const lum = Math.min(1, Math.max(0, Math.pow(0.2126 * cam[0] + 0.7152 * cam[1] + 0.0722 * cam[2], 0.45)));
  const pulse = 1 + VOID_PULSE * Math.sin(RIP_W * t);
  return [0, 1, 2].map((i) => {
    const bg = mix(VOID_DARK[i], VOID_LIGHT[i], lum);
    const fill = VOID_FILL[i] * (0.88 + 0.12 * lum);
    const display = Math.min(1, Math.max(0, mix(bg, fill, region) + VOID_GLOW[i] * ring * pulse * (1 - region)));
    return display * display;
  });
}
