import { describe, expect, it } from 'vitest';
import {
  DIGITAL_MAX_COLS, DIGITAL_MIN_COLS, DIGITAL_ROWS, GLYPH_CELL_PX, GLYPH_COLS, GLYPH_PAD, GLYPH_ROWS, GLYPHS,
  digitalColumns, glyphCell,
} from '../src/glyphs.js';

describe('glyph set and atlas layout', () => {
  it('has one unique glyph per atlas cell (64 cells, 8 x 8)', () => {
    expect(GLYPHS.length).toBe(GLYPH_COLS * GLYPH_ROWS);
    expect(GLYPHS.length).toBe(64);
    expect(new Set(GLYPHS).size).toBe(GLYPHS.length);
  });

  it('includes digits, hex and lower-case letters, operators, brackets and punctuation', () => {
    for (const ch of '0123456789ABCDEFacefghiklmnorstx+-*/%=<>!&|^~?()[]{};:.,_#$"\'@\\`') expect(GLYPHS).toContain(ch);
  });

  it('places each glyph cell inside a 512 x 512 atlas', () => {
    const w = GLYPH_COLS * GLYPH_CELL_PX;
    const h = GLYPH_ROWS * GLYPH_CELL_PX;
    expect(w).toBe(512);
    expect(h).toBe(512);
    for (let i = 0; i < GLYPHS.length; i++) {
      const { x, y } = glyphCell(i);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x + GLYPH_CELL_PX).toBeLessThanOrEqual(w);
      expect(y + GLYPH_CELL_PX).toBeLessThanOrEqual(h);
    }
  });

  it('keeps sampling inside each cell: the inset pad leaves a margin on every side', () => {
    expect(GLYPH_PAD).toBeGreaterThan(0);
    expect(GLYPH_PAD).toBeLessThan(0.5);
  });
});

describe('digital grid', () => {
  it('gives square cells: the column count tracks the aspect at a fixed row count', () => {
    expect(digitalColumns(16 / 9)).toBe(Math.round(DIGITAL_ROWS * 16 / 9));
    expect(digitalColumns(9 / 16)).toBe(Math.round(DIGITAL_ROWS * 9 / 16)); // 50
  });

  it('clamps extreme and invalid aspects', () => {
    expect(digitalColumns(10)).toBe(DIGITAL_MAX_COLS);
    expect(digitalColumns(0)).toBe(DIGITAL_MIN_COLS);
    expect(digitalColumns(NaN)).toBe(DIGITAL_MIN_COLS);
  });
});
