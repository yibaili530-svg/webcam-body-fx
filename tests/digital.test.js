import { describe, expect, it } from 'vitest';
import {
  DIGITAL_MAX_COLS, DIGITAL_MIN_COLS, DIGITAL_ROWS, GLYPH_CELL_PX, GLYPH_COLS, GLYPH_PAD, GLYPH_ROWS, GLYPHS,
  digitalColumns, glyphCell,
} from '../src/glyphs.js';
import * as digital from '../src/digital.js';
import { COMPOSITE_FRAG, MODE_INDEX } from '../src/view.js';

// Effect 5 (代码数字化). Three layers of checks:
//  1. Grid and atlas maths (pure functions).
//  2. Colour and motion: the JS mirror in src/digital.js, whose constants are also injected into the GLSL.
//  3. Wiring: the GLSL text of digitalCode() / digitalHead() must contain the same expressions as the
//     mirror, and digitalCode() must not read the camera. No browser run here: these are mathematical
//     checks on the functions and the shader text, not a visual test.

const {
  DIGITAL_AMBER, DIGITAL_BG_LEVEL, DIGITAL_BLUE, DIGITAL_CYAN, DIGITAL_GLINT_FLOOR, DIGITAL_GLINT_RATE,
  DIGITAL_MAGENTA, DIGITAL_PALETTE_HOLD, DIGITAL_STREAM_MIN, DIGITAL_STREAM_RANGE, DIGITAL_VIOLET, digitalColour,
  fract1, glyphAtlasUv, headDistance, paletteHue, streamHead,
} = digital;

const digitalBody = COMPOSITE_FRAG.match(/vec3 digitalCode\(vec2 p, float t\) \{([\s\S]*?)\n {2}\}/)?.[1] ?? '';
const digitalHeadBody = COMPOSITE_FRAG.match(/float digitalHead\(float col, float t\) \{([\s\S]*?)\n {2}\}/)?.[1] ?? '';
const digitalHueBody = COMPOSITE_FRAG.match(/vec3 digitalHue\(float t, float pick\) \{([\s\S]*?)\n {2}\}/)?.[1] ?? '';

const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
// Chromatic direction: the colour with its brightness removed (largest channel = 1).
const direction = ([r, g, b]) => {
  const m = Math.max(r, g, b);
  return [r / m, g / m, b / m];
};
const sameDirection = (a, b) => Math.max(...a.map((c, i) => Math.abs(c - b[i]))) < 1e-6;
/** Number of distinct chromatic directions among a list of colours. */
function distinctDirections(colours) {
  const seen = [];
  for (const rgb of colours) {
    const d = direction(rgb);
    if (!seen.some((s) => sameDirection(s, d))) seen.push(d);
  }
  return seen.length;
}
// The palette in its display-referred form, as digitalColour() sees it (squared to linear there).
const PALETTE_STATES = [
  [DIGITAL_CYAN],
  [DIGITAL_MAGENTA, DIGITAL_VIOLET],
  [DIGITAL_AMBER],
  [DIGITAL_BLUE, DIGITAL_CYAN],
];
const PALETTE_DIRECTIONS = [DIGITAL_CYAN, DIGITAL_MAGENTA, DIGITAL_VIOLET, DIGITAL_AMBER, DIGITAL_BLUE]
  .map((c) => direction(c.map((x) => x * x)));
const stateOf = (t) => Math.floor(t / DIGITAL_PALETTE_HOLD) % 4;
/** Ink-1 glyph colour (linear) of a cell centre, the colour the eye sees on the letter. */
const glyphAt = (col, row, t) => digitalColour({ u: (col + 0.5) / 156, v: (row + 0.5) / DIGITAL_ROWS, col, t, ink: 1 });
/** A spread of cells across the grid: 20 columns by every row. */
function sampleCells(cols = 20) {
  const cells = [];
  for (let col = 0; col < cols; col++) for (let row = 0; row < DIGITAL_ROWS; row++) cells.push({ col: col * 7 + 3, row });
  return cells;
}

describe('grid density and shape', () => {
  it('has a denser grid than the old 48 rows, within an 80 to 96 target', () => {
    expect(DIGITAL_ROWS).toBeGreaterThanOrEqual(80);
    expect(DIGITAL_ROWS).toBeLessThanOrEqual(96);
    expect(DIGITAL_ROWS).toBeGreaterThan(48);
  });

  it('keeps cells near-square across aspects (cell aspect = (aspect / cols) * rows)', () => {
    // Up to about 2.27 (200 columns); wider viewports hit DIGITAL_MAX_COLS and their cells stretch.
    for (const aspect of [16 / 9, 9 / 16, 1, 2.2]) {
      const cellAspect = (aspect / digitalColumns(aspect)) * DIGITAL_ROWS;
      expect(Math.abs(cellAspect - 1), `aspect ${aspect}`).toBeLessThan(0.02);
    }
  });

  it('gives the expected column counts at 16:9, 9:16 and 1:1', () => {
    expect(digitalColumns(16 / 9)).toBe(156);
    expect(digitalColumns(9 / 16)).toBe(50);
    expect(digitalColumns(1)).toBe(88);
  });

  it('stays inside the column limits for extreme aspects', () => {
    expect(digitalColumns(10)).toBe(DIGITAL_MAX_COLS);
    expect(digitalColumns(0.001)).toBe(DIGITAL_MIN_COLS);
  });
});

describe('glyph atlas coverage and uv bounds', () => {
  const samples = [0, 0.25, 0.5, 0.75, 1];

  it('maps every glyph into its own cell, inside the inset box', () => {
    const origins = new Set();
    const cu = 1 / GLYPH_COLS;
    const cv = 1 / GLYPH_ROWS;
    for (let i = 0; i < GLYPHS.length; i++) {
      const { x, y } = glyphCell(i);
      const u0 = x / (GLYPH_COLS * GLYPH_CELL_PX);
      const v0 = y / (GLYPH_ROWS * GLYPH_CELL_PX);
      for (const lu of samples) {
        for (const lv of samples) {
          const { u, v } = glyphAtlasUv(i, lu, lv);
          expect(u).toBeGreaterThanOrEqual(u0 + GLYPH_PAD * cu - 1e-12);
          expect(u).toBeLessThanOrEqual(u0 + (1 - GLYPH_PAD) * cu + 1e-12);
          expect(v).toBeGreaterThanOrEqual(v0 + GLYPH_PAD * cv - 1e-12);
          expect(v).toBeLessThanOrEqual(v0 + (1 - GLYPH_PAD) * cv + 1e-12);
        }
      }
      origins.add(`${u0},${v0}`);
    }
    expect(origins.size).toBe(GLYPHS.length);
  });

  it('keeps every uv inside [0, 1]', () => {
    for (let i = 0; i < GLYPHS.length; i++) {
      for (const [lu, lv] of [[0, 0], [1, 1]]) {
        const { u, v } = glyphAtlasUv(i, lu, lv);
        expect(u).toBeGreaterThanOrEqual(0);
        expect(u).toBeLessThanOrEqual(1);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('keeps the pad at least 8 texels, enough for the mip levels the grid uses', () => {
    // The grid uses mip 1.4 to 2.4 for 2160 to 1080 device-pixel rows; a mip-m sample blends about 2^m texels.
    expect(GLYPH_PAD * GLYPH_CELL_PX).toBeGreaterThanOrEqual(8);
  });

  it('draws a 64-glyph set covering digits, letters, operators, brackets and punctuation', () => {
    expect(GLYPHS.length).toBe(64);
    expect(GLYPHS).toMatch(/[0-9]/);
    expect(GLYPHS).toMatch(/[A-F]/);
    expect(GLYPHS).toMatch(/[a-z]/);
    expect(GLYPHS).toMatch(/[+\-*/%=<>!&|^~?]/);
    expect(GLYPHS).toMatch(/[()[\]{}]/);
    expect(GLYPHS).toMatch(/[;:.,_#$"'@\\`]/);
  });
});

describe('colour: opaque, dark background, real hue change', () => {
  it('with no ink the cell is a dark background tinted with its hue (never black, never bright)', () => {
    for (const [u, v, col, t] of [[0.1, 0.2, 3, 0], [0.8, 0.6, 40, 7.3], [0.5, 0.9, 120, 31]]) {
      const rgb = digitalColour({ u, v, col, t, ink: 0 });
      const max = Math.max(...rgb);
      expect(max).toBeLessThanOrEqual(DIGITAL_BG_LEVEL + 1e-9);
      expect(max).toBeGreaterThan(0.001);
      expect(max - Math.min(...rgb)).toBeGreaterThan(0);
    }
  });

  it('with full ink every channel is finite and inside [0, 1], and the glyph reaches full cell brightness', () => {
    let peak = 0;
    for (let i = 0; i < 2000; i++) {
      const rgb = digitalColour({ u: (i * 0.618) % 1, v: (i * 0.381) % 1, col: i % 156, t: i * 0.037, ink: 1 });
      for (const c of rgb) {
        expect(Number.isFinite(c)).toBe(true);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
        peak = Math.max(peak, c);
      }
    }
    expect(peak).toBeGreaterThan(0.9);
  });

  it('every palette colour is saturated: chroma (max - min) stays at or above 0.7', () => {
    for (const c of [DIGITAL_CYAN, DIGITAL_MAGENTA, DIGITAL_VIOLET, DIGITAL_AMBER, DIGITAL_BLUE]) {
      expect(Math.max(...c) - Math.min(...c)).toBeGreaterThanOrEqual(0.7);
    }
  });
});

describe('palette: global mono/duo cycle, at most two hues, instant switches', () => {
  it('cycles mono cyan, duo magenta + violet, mono amber, duo blue + cyan, every 1.5 s', () => {
    expect(DIGITAL_PALETTE_HOLD).toBeGreaterThanOrEqual(1);
    expect(DIGITAL_PALETTE_HOLD).toBeLessThanOrEqual(2);
    const cells = sampleCells();
    for (let k = 0; k < 8; k++) {
      const t = k * DIGITAL_PALETTE_HOLD + 0.1; // mid-hold, away from both boundaries
      const colours = cells.map(({ col, row }) => glyphAt(col, row, t));
      const state = k % 4;
      const expectedHues = PALETTE_STATES[state].length;
      expect(distinctDirections(colours), `hold ${k}`).toBe(expectedHues);
      for (const rgb of colours) {
        const d = direction(rgb);
        expect(PALETTE_STATES[state].some((c) => sameDirection(d, direction(c.map((x) => x * x)))), `hold ${k}`).toBe(true);
      }
    }
  });

  it('mono states give every cell the same hue, and duo states give each cell one of its two', () => {
    const cells = sampleCells();
    const mono = cells.map(({ col, row }) => glyphAt(col, row, 0.1));
    expect(distinctDirections(mono)).toBe(1);
    const duo = cells.map(({ col, row }) => glyphAt(col, row, 1.6));
    expect(distinctDirections(duo)).toBe(2);
  });

  it('at most two chromatic hues are on screen at any moment, and only the five palette colours appear', () => {
    const cells = sampleCells(12);
    for (let t = 0; t < 12; t += 0.1) {
      const colours = cells.map(({ col, row }) => glyphAt(col, row, t));
      expect(distinctDirections(colours), `t ${t.toFixed(2)}`).toBeLessThanOrEqual(2);
      for (const rgb of colours) {
        const d = direction(rgb);
        expect(PALETTE_DIRECTIONS.some((p) => sameDirection(p, d)), `t ${t.toFixed(2)}`).toBe(true);
      }
    }
  });

  it('a cell keeps its duo colour for the whole hold and for every later hold in the same state', () => {
    const cells = sampleCells(4);
    const at = (t) => cells.map(({ col, row }) => direction(glyphAt(col, row, t)));
    const first = at(1.5 * DIGITAL_PALETTE_HOLD); // duo: magenta / violet
    const later = at(1.9 * DIGITAL_PALETTE_HOLD); // same hold
    const again = at(1.5 * DIGITAL_PALETTE_HOLD + 4 * DIGITAL_PALETTE_HOLD); // the next magenta / violet hold, a cycle later
    first.forEach((d, i) => {
      expect(sameDirection(d, later[i])).toBe(true);
      expect(sameDirection(d, again[i])).toBe(true);
    });
  });

  it('switches are instant: a cell goes straight from one state colour to the next, never through a third hue', () => {
    const cells = sampleCells(4);
    for (let k = 1; k < 8; k++) {
      const boundary = k * DIGITAL_PALETTE_HOLD;
      const union = [...PALETTE_STATES[(k - 1) % 4], ...PALETTE_STATES[k % 4]]
        .map((c) => direction(c.map((x) => x * x)));
      for (const { col, row } of cells) {
        for (const t of [boundary - 1e-3, boundary - 1e-6, boundary, boundary + 1e-6, boundary + 1e-3]) {
          const d = direction(glyphAt(col, row, t));
          expect(union.some((u) => sameDirection(u, d)), `boundary ${k}, t ${t}`).toBe(true);
        }
      }
    }
  });

  it('letters stay visible: at full ink every glyph is above the floor and no cell goes to black', () => {
    const floor = 0.25 * DIGITAL_GLINT_FLOOR; // the dimmest body level (trail floor x glint floor)
    const cells = sampleCells(10);
    let dimmest = Infinity;
    for (let t = 0; t < 12; t += 0.2) {
      for (const { col, row } of cells) {
        const peak = Math.max(...glyphAt(col, row, t));
        dimmest = Math.min(dimmest, peak);
      }
    }
    expect(dimmest).toBeGreaterThanOrEqual(floor - 1e-9);
    expect(dimmest).toBeGreaterThan(0.15);
    expect(dimmest).toBeGreaterThan(DIGITAL_BG_LEVEL * 4);
  });

  it('letter glints are per character, stay between the floor and full, and change smoothly at 60 Hz', () => {
    const cells = sampleCells(6);
    for (const { col, row } of cells) {
      let prev = digital.digitalGlint(col, row, 0);
      let min = prev;
      let max = prev;
      for (let t = 1 / 60; t < 6; t += 1 / 60) {
        const g = digital.digitalGlint(col, row, t);
        expect(g).toBeGreaterThanOrEqual(DIGITAL_GLINT_FLOOR - 1e-12);
        expect(g).toBeLessThanOrEqual(1 + 1e-12);
        // The glint's phase slope is at most 0.45 per rad (glint floor 0.7), so one 60 Hz frame moves it at most 0.45 * rate / 60.
        expect(Math.abs(g - prev)).toBeLessThan((0.45 * DIGITAL_GLINT_RATE) / 60);
        min = Math.min(min, g);
        max = Math.max(max, g);
        prev = g;
      }
      expect(max - min).toBeGreaterThan(0.15); // visible sparkle
    }
    // Phases differ between characters, so the glints do not all flash together.
    const phases = new Set(cells.map(({ col, row }) => digital.digitalGlint(col, row, 1.234).toFixed(4)));
    expect(phases.size).toBeGreaterThan(cells.length / 2);
  });

  it('a column head is the full cell hue (brightest point, same direction), never white', () => {
    const col = 21;
    const t = 0.7; // mono cyan
    const h = streamHead(col, t);
    const head = digitalColour({ u: 0.5, v: h, col, t, ink: 1 });
    expect(Math.max(...head)).toBeGreaterThan(0.95);
    expect(sameDirection(direction(head), direction(DIGITAL_CYAN.map((x) => x * x)))).toBe(true);
    expect(Math.min(...head)).toBeLessThan(0.05); // cyan has no red: white would fill it in
  });
});

describe('streams: bright heads, varied speeds, smooth motion', () => {
  it('a stream head is brighter than the tail behind it', () => {
    const col = 21;
    const t = 3.3;
    const h = streamHead(col, t);
    const head = digitalColour({ u: 0.5, v: h - 0.001, col, t, ink: 1 });
    const tail = digitalColour({ u: 0.5, v: h - 0.2, col, t, ink: 1 });
    expect(luminance(head)).toBeGreaterThan(luminance(tail));
    expect(headDistance(col, h - 0.001, t)).toBeCloseTo(0.001, 9);
  });

  it('column speeds vary: distinct columns move at distinct speeds', () => {
    const speeds = new Set();
    for (let col = 0; col < 40; col++) {
      speeds.add(Math.round(fract1(streamHead(col, 1e-3) - streamHead(col, 0)) / 1e-3 * 1e6));
    }
    expect(speeds.size).toBeGreaterThan(30);
  });

  it('every head moves between DIGITAL_STREAM_MIN and MIN + RANGE screen heights per second', () => {
    for (let col = 0; col < 200; col++) {
      const speed = fract1(streamHead(col, 1e-3) - streamHead(col, 0)) / 1e-3;
      expect(speed).toBeGreaterThanOrEqual(DIGITAL_STREAM_MIN - 1e-3);
      expect(speed).toBeLessThanOrEqual(DIGITAL_STREAM_MIN + DIGITAL_STREAM_RANGE + 1e-3);
    }
  });

  it('no full-screen strobe: at 60 Hz fewer than 10 % of the cells change colour by more than 0.15', () => {
    const cols = digitalColumns(16 / 9);
    const dt = 1 / 60;
    const t = 12.345;
    let changed = 0;
    let total = 0;
    for (let row = 0; row < DIGITAL_ROWS; row++) {
      for (let col = 0; col < cols; col++) {
        const u = (col + 0.5) / cols;
        const v = (row + 0.5) / DIGITAL_ROWS;
        const a = digitalColour({ u, v, col, t, ink: 1 });
        const b = digitalColour({ u, v, col, t: t + dt, ink: 1 });
        if (Math.max(...a.map((c, i) => Math.abs(c - b[i]))) > 0.15) changed++;
        total++;
      }
    }
    expect(changed / total).toBeLessThan(0.1);
  });
});

describe('camera independence and wiring', () => {
  it('the colour is a pure function of (position, time, column, ink)', () => {
    const args = { u: 0.42, v: 0.37, col: 17, t: 9.9, ink: 0.6 };
    expect(digitalColour(args)).toEqual(digitalColour({ ...args }));
  });

  it('the GLSL digitalCode() and digitalHead() exist', () => {
    expect(digitalBody.length).toBeGreaterThan(0);
    expect(digitalHeadBody.length).toBeGreaterThan(0);
  });

  it('digitalCode() and digitalHead() never read the camera, the video, or any mask or matte', () => {
    const code = (src) => src.replace(/\/\/.*$/gm, ''); // comments may say "camera"; the code may not
    for (const name of ['camera(', 'uVideo', 'uRawMask', 'uMask', 'uMatte', 'uFluid', 'luma', 'luminance', 'cam']) {
      expect(code(digitalBody), name).not.toContain(name);
      expect(code(digitalHeadBody), name).not.toContain(name);
    }
  });

  it('effect 5 is reached only through its own mode branch, with the region gate and mix unchanged', () => {
    expect(COMPOSITE_FRAG).toContain(`abs(uMode - ${MODE_INDEX.effect5}.0) < 0.5`);
    expect(COMPOSITE_FRAG.match(/digitalCode\(screen, t\)/g)?.length).toBe(1);
    expect(COMPOSITE_FRAG).toContain(
      'float region = crisp(regionConf(uRawMask, screen));\n      col = mix(cam, digitalCode(screen, t), region);',
    );
  });

  it('the output is written with alpha 1 (opaque)', () => {
    expect(COMPOSITE_FRAG).toContain('gl_FragColor = vec4(col, 1.0);');
  });

  it('the injected constants equal the JS constants (generated, not hand-typed)', () => {
    const glslFloat = (x) => (Number.isInteger(x) ? `${x}.0` : `${x}`);
    for (const name of [
      'DIGITAL_PALETTE_HOLD', 'DIGITAL_GLINT_RATE', 'DIGITAL_GLINT_FLOOR', 'DIGITAL_STREAM_MIN',
      'DIGITAL_STREAM_RANGE', 'DIGITAL_TRAIL', 'DIGITAL_TRAIL_FLOOR', 'DIGITAL_HEAD_SHARP', 'DIGITAL_BG_LEVEL',
    ]) {
      expect(COMPOSITE_FRAG, name).toContain(`const float ${name} = ${glslFloat(digital[name])};`);
    }
    for (const name of ['DIGITAL_CYAN', 'DIGITAL_MAGENTA', 'DIGITAL_VIOLET', 'DIGITAL_AMBER', 'DIGITAL_BLUE']) {
      const rgb = digital[name].map(glslFloat).join(', ');
      expect(COMPOSITE_FRAG, name).toContain(`const vec3 ${name} = vec3(${rgb});`);
    }
    expect(COMPOSITE_FRAG).toContain(`const float DIGITAL_ROWS = ${DIGITAL_ROWS}.0;`);
    expect(COMPOSITE_FRAG).toContain(`const float GLYPH_COUNT = ${GLYPHS.length}.0;`);
    expect(COMPOSITE_FRAG).toContain(`const float GLYPH_ROWS = ${GLYPH_ROWS}.0;`);
  });

  it('the GLSL uses the same stream, palette, glint and glyph expressions as the mirror', () => {
    for (const line of [
      'float speed = DIGITAL_STREAM_MIN + DIGITAL_STREAM_RANGE * hash(col * 1.37 + 0.5);',
      'return fract(hash(col * 2.31 + 0.9) + speed * t);',
    ]) {
      expect(digitalHeadBody).toContain(line);
    }
    for (const line of [
      'float wave = 0.5 + 0.5 * sin(DIGITAL_GLINT_RATE * t + 6.28318 * hash(cell.x * 7.77 + cell.y * 2.13 + 0.61));',
      'return DIGITAL_GLINT_FLOOR + (1.0 - DIGITAL_GLINT_FLOOR) * pow(wave, 3.0);',
    ]) {
      expect(COMPOSITE_FRAG).toContain(line);
    }
    for (const line of [
      'float state = mod(floor(t / DIGITAL_PALETTE_HOLD), 4.0);',
      'if (state < 0.5) return DIGITAL_CYAN;',
      'if (state < 1.5) return pick < 0.5 ? DIGITAL_MAGENTA : DIGITAL_VIOLET;',
      'if (state < 2.5) return DIGITAL_AMBER;',
      'return pick < 0.5 ? DIGITAL_BLUE : DIGITAL_CYAN;',
    ]) {
      expect(digitalHueBody).toContain(line);
    }
    for (const line of [
      'vec3 hue = digitalHue(t, hash(cell.x * 3.91 + cell.y * 17.13 + 0.37));',
      'hue *= hue; // display -> linear',
      'float d = fract(digitalHead(cell.x, t) - c.y);',
      'float level = (DIGITAL_TRAIL_FLOOR + (1.0 - DIGITAL_TRAIL_FLOOR) * exp(-DIGITAL_TRAIL * d)) * digitalGlint(cell, t);',
      'float head = exp(-DIGITAL_HEAD_SHARP * d);',
      'vec3 glyphColour = hue * mix(level, 1.0, head);',
      'float tick = floor(t / TEMPO_PERIOD + hash(cell.y * 0.37 + 0.11));',
      'float idx = floor(hash(cell.x * 12.9898 + cell.y * 78.233 + tick * 0.618) * GLYPH_COUNT);',
      'return mix(hue * DIGITAL_BG_LEVEL, glyphColour, ink);',
    ]) {
      expect(digitalBody).toContain(line);
    }
  });

  it('the GLSL colour path has no white and no rainbow phase: the head and glints stay on the cell hue', () => {
    for (const body of [digitalBody, digitalHueBody]) {
      expect(body).not.toContain('vec3(1.0)');
      expect(body).not.toMatch(/cos\(/);
    }
    expect(COMPOSITE_FRAG).not.toContain('DIGITAL_HEAD_WHITE');
    expect(COMPOSITE_FRAG).not.toContain('DIGITAL_HUE_');
  });
});
