// Temporal persistence for the processed person coverage (effects 1, 3, 4 and 6). Pure, no DOM.
// Runs once per NEW segmentation result, at mask resolution, on the CPU. The clock is the result's
// own timestamp (performance.now at the segmenter call), never a frame count.
//
// A pixel that the segmenter drops is held at its last strong value only when it is ENCLOSED by
// present person pixels: within PERSIST_ENCLOSE mask pixels on all four sides. Real dropouts (holes
// and notches inside the body) are enclosed, while the trailing edge of a moving person is not, so a
// hold cannot leave a ghost outside the silhouette. The hold lasts at most PERSIST_HOLD_MS, then
// expires hard. Within that window the held value never drops below the solid contour (128), so the
// outline does not soften or grow during a hold; it only closes at expiry.
//
// The raw mask is never passed through here: effects 2 and 5 keep the unexpanded segmenter output.

export const PERSIST_HOLD_MS = 150;
/** Shader contour (see coverage.js SOLID): holds never go below this. */
export const PERSIST_SOLID = 128;
/** A dropout must have present pixels within this many mask pixels on all four sides. */
export const PERSIST_ENCLOSE = 8;

/**
 * Returns `{ update(raw, at, out), reset(), stats }` for a w x h mask. `update` reads the raw bytes
 * (0..255) and writes `out`, which must be a different array. Output is raw everywhere except held
 * enclosed dropouts. Nothing is allocated in `update`.
 */
export function createMaskPersistence(w, h) {
  const n = w * h;
  const seenAt = new Float64Array(n).fill(-Infinity);
  const strength = new Uint8Array(n);
  const present = new Uint8Array(n);
  const flag = new Uint8Array(n);
  const enclosed = new Uint8Array(n);
  const hold = PERSIST_HOLD_MS;
  let heldPx = 0;

  // enclosed[i] = 1 when present pixels lie within PERSIST_ENCLOSE on all four sides of i.
  // Each direction is one linear sweep that tracks the last present index.
  function markEnclosed() {
    const R = PERSIST_ENCLOSE;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let last = -Infinity;
      for (let x = 0; x < w; x++) {
        if (present[row + x]) last = x;
        flag[row + x] = x - last <= R ? 1 : 0;
      }
      last = Infinity;
      for (let x = w - 1; x >= 0; x--) {
        if (present[row + x]) last = x;
        if (last - x > R) flag[row + x] = 0;
      }
    }
    for (let x = 0; x < w; x++) {
      let last = -Infinity;
      for (let y = 0; y < h; y++) {
        const i = y * w + x;
        if (present[i]) last = y;
        enclosed[i] = flag[i] && y - last <= R ? 1 : 0;
      }
      last = Infinity;
      for (let y = h - 1; y >= 0; y--) {
        const i = y * w + x;
        if (present[i]) last = y;
        if (last - y > R) enclosed[i] = 0;
      }
    }
  }

  return {
    update(raw, at, out) {
      for (let i = 0; i < n; i++) present[i] = raw[i] >= PERSIST_SOLID ? 1 : 0;
      markEnclosed();
      heldPx = 0;
      for (let i = 0; i < n; i++) {
        const r = raw[i];
        if (present[i]) {
          out[i] = r;
          strength[i] = r;
          seenAt[i] = at;
          continue;
        }
        let v = r;
        const age = at - seenAt[i];
        if (enclosed[i] && age <= hold) {
          // Linear fall from the last strong value to the contour over the hold, then the hard expiry.
          const fade = Math.round(255 - (255 - PERSIST_SOLID) * Math.max(0, age) / hold);
          const held = Math.min(strength[i], fade);
          if (held > v) {
            v = held;
            heldPx++;
          }
        }
        out[i] = v;
      }
      return heldPx;
    },
    /** Forget everything (camera switch, stop). The next result starts without any hold. */
    reset() {
      seenAt.fill(-Infinity);
      strength.fill(0);
      heldPx = 0;
    },
    /** Pixels that were filled by a hold in the last update. */
    get heldPx() {
      return heldPx;
    },
  };
}
