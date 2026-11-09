// Effect centre for the radial effects (Kaleidoscope, Ripple): the centroid of the raw person mask,
// computed once per segmentation result. Pure, no DOM. Coordinates are source-normalized
// (row 0 at the top), the same space as the mask texture.

/** Centroid of the bytes >= 128 in a w x h mask, or null if nothing is set. */
export function maskCentroid(bytes, w, h) {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (bytes[row + x] < 128) continue;
      sx += x + 0.5;
      sy += y + 0.5;
      n++;
    }
  }
  if (n === 0) return null;
  return { x: sx / n / w, y: sy / n / h };
}

/**
 * Moves `prev` towards `next` by `alpha` per update. With the segmenter at ~30 Hz, alpha 0.5 keeps
 * the anchor within a few frames of the person without a long trailing ghost.
 */
export function smoothAnchor(prev, next, alpha) {
  return { x: prev.x + (next.x - prev.x) * alpha, y: prev.y + (next.y - prev.y) * alpha };
}
