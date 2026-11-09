// Shared animation tempo. Every effect's motion is timed from the ripple (effect 4), so the whole
// set of effects moves on one clock. Plain numbers only: this module has no DOM and no imports, so the
// effect modules can read it without an import cycle through view.js.
// Exception: fluid (effect 1) is exempt. Its authored slow flow is kept as written in fluid.js, and it
// does not read EFFECT_TEMPO. Scaling it to this rate made the dye alias into static.

/** Ripple angular rate, rad/s. The ripple phase is RIP_K * r - RIP_W * t (view.js). */
export const RIP_W = 14;

/** Shared tempo, rad/s: the ripple's angular rate. Every re-timed effect quantity is defined against it. */
export const EFFECT_TEMPO = RIP_W;

/** One ripple period, s: 2π / EFFECT_TEMPO (about 0.449 s). */
export const TEMPO_PERIOD = 6.28318 / EFFECT_TEMPO;
