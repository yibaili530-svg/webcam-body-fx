// Effect 5 (代码数字化): glyph set, atlas layout and the one-time canvas atlas. No downloaded
// fonts: the atlas is drawn with the system monospace face on a 2D canvas, once per view.

// Rows of the digital grid (cells are square: the column count follows the aspect). 88 rows
// on a 16:9 viewport gives 156 columns; the old 48 rows gave 85.
export const DIGITAL_ROWS = 88;
export const DIGITAL_MIN_COLS = 16;
export const DIGITAL_MAX_COLS = 200;

/** Atlas layout: GLYPH_COLS x GLYPH_ROWS cells of GLYPH_CELL_PX, row 0 at the top of the canvas. */
export const GLYPH_COLS = 8;
export const GLYPH_ROWS = 8;
export const GLYPH_CELL_PX = 64;
/**
 * Inset of each glyph inside its cell, as a fraction of the cell. At the mip levels the grid uses
 * (about 1.4 to 2.4 for 2160 to 1080 device-pixel rows) the 9.6 px margin keeps neighbouring cells out of the filter.
 */
export const GLYPH_PAD = 0.15;
/** Glyph size in the atlas, as a fraction of the cell (the glyph box is 70 % of the cell after GLYPH_PAD). */
export const GLYPH_FONT = 0.7;

// 64 glyphs, one per atlas cell: digits 10, hex letters 6, lower-case letters 16, operators 14,
// brackets 6, punctuation 12. Every glyph is unique (tests/glyphs.test.js).
export const GLYPHS = '0123456789ABCDEFacefghiklmnorstx+-*/%=<>!&|^~?()[]{};:.,_#$"\'@\\`';

/** Number of columns for a viewport aspect (w / h), so the digital cells are square. */
export function digitalColumns(aspect) {
  if (!(aspect > 0)) return DIGITAL_MIN_COLS;
  return Math.min(DIGITAL_MAX_COLS, Math.max(DIGITAL_MIN_COLS, Math.round(DIGITAL_ROWS * aspect)));
}

/** Atlas cell of glyph index i: column, row (row 0 at the top) and pixel origin. */
export function glyphCell(i) {
  const col = i % GLYPH_COLS;
  const row = Math.floor(i / GLYPH_COLS);
  return { col, row, x: col * GLYPH_CELL_PX, y: row * GLYPH_CELL_PX };
}

/**
 * Draws the atlas into `canvas` (white glyphs on black; the shader reads the red channel). Needs a
 * 2D canvas context, so it is only called in the browser.
 */
export function drawGlyphAtlas(canvas) {
  canvas.width = GLYPH_COLS * GLYPH_CELL_PX;
  canvas.height = GLYPH_ROWS * GLYPH_CELL_PX;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${Math.round(GLYPH_CELL_PX * GLYPH_FONT)}px ui-monospace, Menlo, Consolas, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < GLYPHS.length; i++) {
    const { x, y } = glyphCell(i);
    ctx.fillText(GLYPHS[i], x + GLYPH_CELL_PX / 2, y + GLYPH_CELL_PX / 2 + 2);
  }
  return canvas;
}
