import { describe, expect, it } from 'vitest';
import {
  SLICE_CONTENT_AMP, SLICE_EDGE_AMP, SLICE_ROWS, sliceCell, sliceColumns, sliceEdge, sliceSource, sliceWave,
} from '../src/slices.js';

// Sample times spread over minutes, so the boundaries visit many configurations.
const TIMES = Array.from({ length: 400 }, (_, i) => i * 0.37 + 0.05);
const GRID_PTS = Array.from({ length: 41 }, (_, i) => i / 40);

describe('column count and tile budget', () => {
  it('gives 18 columns at 16:9, so 10 x 18 = 180 tiles', () => {
    const cols = sliceColumns(16 / 9);
    expect(cols).toBe(18);
    expect(SLICE_ROWS * cols).toBe(180);
  });

  it('gives 6 columns at 9:16, so 60 tiles, and clamps extreme aspects', () => {
    expect(sliceColumns(9 / 16)).toBe(6);
    expect(SLICE_ROWS * sliceColumns(9 / 16)).toBe(60);
    expect(sliceColumns(10)).toBe(20);
    expect(sliceColumns(0)).toBe(6);
    expect(sliceColumns(NaN)).toBe(6);
  });
});

describe('bounded waves and boundaries', () => {
  it('wave stays within [-1, 1] for all ids, channels and times, including large t', () => {
    for (const id of [0, 1, 64, 127, 640, 1151]) {
      for (const ch of [0, 1, 2]) {
        for (const t of [...TIMES, 1e4, 1e6]) {
          const w = sliceWave(id, ch, t);
          expect(Number.isFinite(w)).toBe(true);
          expect(Math.abs(w)).toBeLessThanOrEqual(1 + 1e-12);
        }
      }
    }
  });

  it('edges are fixed at 0 and 1 and move by at most SLICE_EDGE_AMP cells', () => {
    for (const cols of [6, 12, 18, 20]) {
      for (const t of TIMES) {
        for (let line = 0; line < 3; line++) {
          const n = line === 0 ? SLICE_ROWS : cols;
          expect(sliceEdge(0, n, line, t)).toBe(0);
          expect(sliceEdge(n, n, line, t)).toBe(1);
          for (let k = 1; k < n; k++) {
            const shift = Math.abs(sliceEdge(k, n, line, t) * n - k);
            expect(shift).toBeLessThanOrEqual(SLICE_EDGE_AMP + 1e-12);
          }
        }
      }
    }
  });

  it('boundaries are strictly increasing, so no cell inverts or collapses', () => {
    for (const t of TIMES) {
      for (let k = 1; k <= SLICE_ROWS; k++) {
        expect(sliceEdge(k, SLICE_ROWS, 0, t)).toBeGreaterThan(sliceEdge(k - 1, SLICE_ROWS, 0, t));
      }
      for (let row = 0; row < SLICE_ROWS; row++) {
        const n = 18;
        for (let k = 1; k <= n; k++) {
          expect(sliceEdge(k, n, 1 + row, t)).toBeGreaterThan(sliceEdge(k - 1, n, 1 + row, t));
        }
      }
    }
  });

  it('cell widths and heights change over time (aspect ratios are not fixed)', () => {
    const widthAt = (t) => sliceCell(0.5, 0.5, t, 18);
    const widths = TIMES.map((t) => {
      const c = widthAt(t);
      return c.right - c.left;
    });
    expect((Math.max(...widths) - Math.min(...widths)) * 18).toBeGreaterThan(0.5); // in cells
  });
});

describe('cell lookup and content mapping', () => {
  it('every point lies inside the cell returned for it', () => {
    for (const t of TIMES.slice(0, 80)) {
      for (const x of GRID_PTS) {
        for (const y of GRID_PTS) {
          const c = sliceCell(x, y, t, 18);
          expect(x).toBeGreaterThanOrEqual(c.left - 1e-12);
          expect(x).toBeLessThanOrEqual(c.right + 1e-12);
          expect(y).toBeGreaterThanOrEqual(c.top - 1e-12);
          expect(y).toBeLessThanOrEqual(c.bottom + 1e-12);
        }
      }
    }
  });

  it('cell ids are unique within a frame', () => {
    for (const t of [0.3, 7.7, 91.2]) {
      const ids = new Set();
      for (let row = 0; row < SLICE_ROWS; row++) {
        for (let col = 0; col < 18; col++) {
          const c = sliceCell(
            (col + 0.5) / 18 + 0.0001, (row + 0.5) / SLICE_ROWS,
            t, 18,
          );
          ids.add(c.id);
        }
      }
      expect(ids.size).toBe(SLICE_ROWS * 18);
    }
  });

  it('content sources are clamped to the frame and finite everywhere', () => {
    for (const t of TIMES.slice(0, 120)) {
      for (const x of GRID_PTS) {
        for (const y of GRID_PTS) {
          const { src } = sliceSource(x, y, t, 18);
          expect(Number.isFinite(src.x) && Number.isFinite(src.y)).toBe(true);
          expect(src.x).toBeGreaterThanOrEqual(0);
          expect(src.x).toBeLessThanOrEqual(1);
          expect(src.y).toBeGreaterThanOrEqual(0);
          expect(src.y).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('content offset is bounded by SLICE_CONTENT_AMP cells from the rest rectangle', () => {
    const cols = 18;
    for (const t of TIMES.slice(0, 80)) {
      for (const x of GRID_PTS) {
        for (const y of GRID_PTS) {
          const { src, cell } = sliceSource(x, y, t, cols);
          const restX = (cell.col + 0.5) / cols;
          const restY = (cell.row + 0.5) / SLICE_ROWS;
          // Offset from the cell's rest centre: half a cell plus the bounded shift, so at most
          // 0.5 + AMP cells away (clamping can only shorten it).
          expect(Math.abs(src.x - restX) * cols).toBeLessThanOrEqual(0.5 + SLICE_CONTENT_AMP + 1e-9);
          expect(Math.abs(src.y - restY) * SLICE_ROWS).toBeLessThanOrEqual(0.5 + SLICE_CONTENT_AMP + 1e-9);
        }
      }
    }
  });

  it('no synchronized rest: at one time, cells do not all share the same content offset', () => {
    const t = 12.34;
    const offsets = new Set();
    for (let row = 0; row < SLICE_ROWS; row++) {
      for (let col = 0; col < 18; col++) {
        const id = row * 64 + col;
        offsets.add(sliceWave(id, 1, t).toFixed(6));
      }
    }
    expect(offsets.size).toBeGreaterThan(100);
  });
});
