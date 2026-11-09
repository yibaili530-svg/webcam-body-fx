// Person-mask coverage at mask resolution (256 px on the short side), run once per new
// segmentation result on the CPU. Pure, no DOM; all buffers are allocated once per size.
//
// 1. Outer band: a Euclidean disc max-dilation of COVERAGE_RADIUS mask pixels. The silhouette can
//    grow by at most that radius, and soft confidence values are kept, so the shader's 0.5
//    contour moves outward by about that much.
// 2. Enclosed holes: background components that don't touch the border and have at most
//    COVERAGE_MAX_HOLE pixels (segmentation dropouts) are filled solid. Larger or open background
//    is never filled.
// Missing limbs are not reconstructed: a region the segmenter never labelled stays uncovered.

export const COVERAGE_RADIUS = 4;
export const COVERAGE_MAX_HOLE = 400;
const SOLID = 128;

// Half-width of the disc on row offset dy (integer grid, Euclidean radius COVERAGE_RADIUS).
const HALF_WIDTH = Array.from({ length: 2 * COVERAGE_RADIUS + 1 }, (_, i) => {
  const dy = i - COVERAGE_RADIUS;
  return Math.floor(Math.sqrt(COVERAGE_RADIUS * COVERAGE_RADIUS - dy * dy));
});

/**
 * Returns `{ run(src, out) }` for a w x h mask of bytes (0..255, row 0 at the top). `run` reads
 * `src` and writes `out`; the two must be different arrays. Nothing is allocated in `run`.
 */
export function createCoverage(w, h) {
  const n = w * h;
  // levels[k] = max over the row window [x - k, x + k]; levels[0] is the source itself.
  const levels = [null];
  for (let k = 1; k <= COVERAGE_RADIUS; k++) levels.push(new Uint8Array(n));
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);

  function horizontal(src) {
    levels[0] = src;
    for (let k = 1; k <= COVERAGE_RADIUS; k++) {
      const prev = levels[k - 1];
      const cur = levels[k];
      for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
          let v = prev[row + x];
          if (x - k >= 0) v = Math.max(v, src[row + x - k]);
          if (x + k < w) v = Math.max(v, src[row + x + k]);
          cur[row + x] = v;
        }
      }
    }
  }

  return {
    run(src, out) {
      horizontal(src);
      // Vertical pass with the disc: row y + dy contributes its window of half-width HALF_WIDTH.
      // Done as contiguous row-wise maxima, which is much cheaper than per-pixel lookups.
      out.fill(0);
      for (let dy = -COVERAGE_RADIUS; dy <= COVERAGE_RADIUS; dy++) {
        const level = levels[HALF_WIDTH[dy + COVERAGE_RADIUS]];
        for (let y = Math.max(0, -dy), yEnd = Math.min(h, h - dy); y < yEnd; y++) {
          const from = (y + dy) * w;
          const to = y * w;
          for (let x = 0; x < w; x++) {
            const v = level[from + x];
            if (v > out[to + x]) out[to + x] = v;
          }
        }
      }

      // Enclosed background components (4-connected) that are small enough become solid.
      seen.fill(0);
      for (let s = 0; s < n; s++) {
        if (seen[s] || out[s] >= SOLID) continue;
        let head = 0;
        let tail = 0;
        let touchesBorder = false;
        queue[tail++] = s;
        seen[s] = 1;
        while (head < tail) {
          const p = queue[head++];
          const x = p % w;
          const y = (p - x) / w;
          if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touchesBorder = true;
          if (x > 0 && !seen[p - 1] && out[p - 1] < SOLID) { seen[p - 1] = 1; queue[tail++] = p - 1; }
          if (x < w - 1 && !seen[p + 1] && out[p + 1] < SOLID) { seen[p + 1] = 1; queue[tail++] = p + 1; }
          if (y > 0 && !seen[p - w] && out[p - w] < SOLID) { seen[p - w] = 1; queue[tail++] = p - w; }
          if (y < h - 1 && !seen[p + w] && out[p + w] < SOLID) { seen[p + w] = 1; queue[tail++] = p + w; }
        }
        if (!touchesBorder && tail <= COVERAGE_MAX_HOLE) {
          for (let i = 0; i < tail; i++) out[queue[i]] = 255;
        }
      }
    },
  };
}
