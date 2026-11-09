import * as THREE from 'three';
import { createCoverage } from './coverage.js';
import { createMaskPersistence } from './mask-persistence.js';
import { paintPose, poseFresh } from './pose-capsules.js';
import { createFluid } from './fluid.js';
import { rasterizeHands } from './handmatte.js';
import { maskCentroid, smoothAnchor } from './anchor.js';
import { sourceToScreen } from './mapping.js';
import { EFFECT_TEMPO, RIP_W, TEMPO_PERIOD } from './tempo.js';
import { VOID_DARK, VOID_FILL, VOID_GLOW, VOID_HALO_R, VOID_LIGHT, VOID_PULSE } from './void.js';
import {
  DIGITAL_ROWS, GLYPH_CELL_PX, GLYPH_COLS, GLYPH_PAD, GLYPH_ROWS, GLYPHS, digitalColumns, drawGlyphAtlas,
} from './glyphs.js';
import {
  DIGITAL_AMBER, DIGITAL_BG_LEVEL, DIGITAL_BLUE, DIGITAL_CYAN, DIGITAL_GLINT_FLOOR, DIGITAL_GLINT_RATE,
  DIGITAL_HEAD_SHARP, DIGITAL_MAGENTA, DIGITAL_PALETTE_HOLD, DIGITAL_STREAM_MIN, DIGITAL_STREAM_RANGE,
  DIGITAL_TRAIL, DIGITAL_TRAIL_FLOOR, DIGITAL_VIOLET,
} from './digital.js';
import {
  SLICE_CONTENT_AMP, SLICE_EDGE_AMP, SLICE_FREQ_MIN, SLICE_FREQ_RANGE, SLICE_HARMONIC, SLICE_ID_STRIDE,
  SLICE_ROWS, sliceColumns,
} from './slices.js';

// Matte resolution matches the segmenter input (short side), in source aspect.
const MATTE_SHORT_SIDE = 256;
// Half-width of the matte's linear edge ramp; the shader thresholds it at 0.5 to ~1 screen px.
const MATTE_FEATHER_PX = 1;
// Weight of each new segmentation in the effect centre (see anchor.js).
const ANCHOR_ALPHA = 0.5;

// Shader branch per gesture mode (the uMode value). Anything else renders the untouched camera.
export const MODE_INDEX = { camera: 0, effect1: 1, effect2: 2, effect3: 3, effect4: 4, effect5: 5, effect6: 6 };

// Kaleidoscope and ripple constants. Interpolated into the shader below, so JS and GLSL agree.
export const KAL_SECTORS = 8;
// One sector step (2π / KAL_SECTORS) per ripple period: the folded pattern repeats once per T.
export const KAL_ROT = EFFECT_TEMPO / KAL_SECTORS; // rad/s, rotation of the sector pattern
export const KAL_SPIN = EFFECT_TEMPO / KAL_SECTORS; // rad/s, rotation of the spiral sample pattern, same step
export const KAL_SPIRAL = 2.0; // rad per screen-height of radius: the spiral arm pitch
// Constant camera magnification: the sample radius is r / KAL_MAG, so the pattern is ~1.1x the
// camera image at every radius and every time. The earlier zoom pulse reached 2.5x (zoom 0.4).
export const KAL_MAG = 1.1;
const RIP_K = 31.4159; // rad per screen-height: ~5 wavefronts per height (wavelength 0.2)
const RIP_AMP = 0.05; // refraction, screen-height units
const RIP_CREST = 0.3; // brightening at the crest of each wavefront

// GLSL float literal for a JS number.
const glslFloat = (x) => (Number.isInteger(x) ? `${x}.0` : `${x}`);

// Shared constants, generated from the same modules as the JS mirrors (slices.js, glyphs.js).
const CONSTANTS = /* glsl */ `
  const float SLICE_ROWS = ${glslFloat(SLICE_ROWS)};
  const float SLICE_EDGE_AMP = ${glslFloat(SLICE_EDGE_AMP)};
  const float SLICE_CONTENT_AMP = ${glslFloat(SLICE_CONTENT_AMP)};
  const float SLICE_HARMONIC = ${glslFloat(SLICE_HARMONIC)};
  const float SLICE_FREQ_MIN = ${glslFloat(SLICE_FREQ_MIN)};
  const float SLICE_FREQ_RANGE = ${glslFloat(SLICE_FREQ_RANGE)};
  const float SLICE_ID_STRIDE = ${glslFloat(SLICE_ID_STRIDE)};
  const float GLYPH_COLS = ${glslFloat(GLYPH_COLS)};
  const float GLYPH_ROWS = ${glslFloat(GLYPH_ROWS)};
  const float GLYPH_COUNT = ${glslFloat(GLYPHS.length)};
  const float GLYPH_PAD = ${glslFloat(GLYPH_PAD)};
  const float DIGITAL_ROWS = ${glslFloat(DIGITAL_ROWS)};
  const float DIGITAL_PALETTE_HOLD = ${glslFloat(DIGITAL_PALETTE_HOLD)};
  const float TEMPO_PERIOD = ${glslFloat(TEMPO_PERIOD)};
  const vec3 DIGITAL_CYAN = vec3(${DIGITAL_CYAN.map(glslFloat).join(', ')});
  const vec3 DIGITAL_MAGENTA = vec3(${DIGITAL_MAGENTA.map(glslFloat).join(', ')});
  const vec3 DIGITAL_VIOLET = vec3(${DIGITAL_VIOLET.map(glslFloat).join(', ')});
  const vec3 DIGITAL_AMBER = vec3(${DIGITAL_AMBER.map(glslFloat).join(', ')});
  const vec3 DIGITAL_BLUE = vec3(${DIGITAL_BLUE.map(glslFloat).join(', ')});
  const float DIGITAL_GLINT_RATE = ${glslFloat(DIGITAL_GLINT_RATE)};
  const float DIGITAL_GLINT_FLOOR = ${glslFloat(DIGITAL_GLINT_FLOOR)};
  const float DIGITAL_STREAM_MIN = ${glslFloat(DIGITAL_STREAM_MIN)};
  const float DIGITAL_STREAM_RANGE = ${glslFloat(DIGITAL_STREAM_RANGE)};
  const float DIGITAL_TRAIL = ${glslFloat(DIGITAL_TRAIL)};
  const float DIGITAL_TRAIL_FLOOR = ${glslFloat(DIGITAL_TRAIL_FLOOR)};
  const float DIGITAL_HEAD_SHARP = ${glslFloat(DIGITAL_HEAD_SHARP)};
  const float DIGITAL_BG_LEVEL = ${glslFloat(DIGITAL_BG_LEVEL)};
  const vec3 VOID_DARK = vec3(${VOID_DARK.map(glslFloat).join(', ')});
  const vec3 VOID_LIGHT = vec3(${VOID_LIGHT.map(glslFloat).join(', ')});
  const vec3 VOID_FILL = vec3(${VOID_FILL.map(glslFloat).join(', ')});
  const vec3 VOID_GLOW = vec3(${VOID_GLOW.map(glslFloat).join(', ')});
  const float VOID_HALO_R = ${glslFloat(VOID_HALO_R)};
  const float VOID_PULSE = ${glslFloat(VOID_PULSE)};
  const float KAL_SECTORS = ${glslFloat(KAL_SECTORS)};
  const float KAL_ROT = ${glslFloat(KAL_ROT)};
  const float KAL_SPIN = ${glslFloat(KAL_SPIN)};
  const float KAL_SPIRAL = ${glslFloat(KAL_SPIRAL)};
  const float KAL_MAG = ${glslFloat(KAL_MAG)};
  const float RIP_K = ${glslFloat(RIP_K)};
  const float RIP_W = ${glslFloat(RIP_W)};
  const float RIP_AMP = ${glslFloat(RIP_AMP)};
  const float RIP_CREST = ${glslFloat(RIP_CREST)};
`;

// Exported so tests can assemble and compile the real strings offline.
export const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

export const COMPOSITE_FRAG = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D uVideo;
  uniform sampler2D uMask;      // processed coverage (coverage.js): effects 1, 3, 4 and 6
  uniform sampler2D uRawMask;   // raw segmenter mask: effects 2 and 5
  uniform sampler2D uMatte;     // hand matte, unexpanded
  uniform sampler2D uFluid;
  uniform sampler2D uGlyphs;    // glyph atlas, mipmapped, row 0 at the top
  uniform vec4 uCrop;
  uniform vec2 uMaskSize;
  uniform vec2 uResolution;
  uniform vec2 uFluidTexel;
  uniform float uHasFluid;
  uniform float uMode;
  uniform float uTime;
  uniform vec2 uAnchor;         // effect centre in screen space (kaleidoscope, ripples)
  uniform float uSliceCols;     // slice columns; rows are SLICE_ROWS
  uniform vec2 uCodeGrid;       // digital cells: columns, DIGITAL_ROWS
  uniform float uGlyphLod;      // mip level for the glyph atlas, from the on-screen cell size

  ${CONSTANTS}

  // Same mapping as mapping.js screenToSource; all source textures store row 0 at the top.
  vec2 toSource(vec2 screen) {
    return vec2(uCrop.x + (1.0 - screen.x) * uCrop.z, uCrop.y + screen.y * uCrop.w);
  }

  vec3 palette(float t) {
    return vec3(0.55, 0.52, 0.60) + vec3(0.45, 0.42, 0.40) * cos(6.28318 * (t + vec3(0.0, 0.33, 0.62)));
  }

  // Flat-facing thin-film fluid: the normal comes from the advected height only, no body volume.
  vec3 shadeFluid(vec2 uv) {
    vec4 f = texture2D(uFluid, uv);
    vec2 e = uFluidTexel * 1.5;
    float hx = texture2D(uFluid, uv + vec2(e.x, 0.0)).b - texture2D(uFluid, uv - vec2(e.x, 0.0)).b;
    float hy = texture2D(uFluid, uv + vec2(0.0, e.y)).b - texture2D(uFluid, uv - vec2(0.0, e.y)).b;
    vec3 n = normalize(vec3(-hx * 18.0, -hy * 18.0, 1.0));

    float r = length(f.rg);
    float phase = atan(f.g, f.r + 1e-5) / 6.28318;
    vec3 base = mix(vec3(0.45, 0.42, 0.50), palette(phase + 0.35 * f.b), smoothstep(0.02, 0.22, r));

    // Thin-film interference: thickness from the advected scalar, angle from the height normal.
    float thickness = 0.30 + 0.70 * f.b;
    vec3 film = 0.5 + 0.5 * cos(6.28318 * 2.0 * 1.33 * thickness * n.z / vec3(0.65, 0.53, 0.45));
    vec3 col = base * mix(vec3(0.62), vec3(1.18), film);
    col += vec3(0.5) * pow(1.0 - n.z, 3.0);
    return col * col; // display-referred palette -> linear
  }

  // ---- Crisp edges. A mask (already expanded on the CPU by coverage.js, or the raw segmenter
  // output) is ~256 px on its short side; it is upsampled with a 4-tap cubic B-spline, then
  // thresholded at 0.5 with a 1-screen-pixel antialiased edge derived from the local confidence
  // gradient (no blur or temporal smoothing in the shader).
  vec4 bspline(float v) {
    vec4 n = vec4(1.0, 2.0, 3.0, 4.0) - v;
    vec4 s = n * n * n;
    float x = s.x;
    float y = s.y - 4.0 * s.x;
    float z = s.z - 4.0 * s.y + 6.0 * s.x;
    return vec4(x, y, z, 6.0 - x - y - z) / 6.0;
  }

  float maskBicubic(sampler2D tex, vec2 uv) {
    vec2 p = uv * uMaskSize - 0.5;
    vec2 f = fract(p);
    p -= f;
    vec4 xc = bspline(f.x);
    vec4 yc = bspline(f.y);
    vec4 c = p.xxyy + vec2(-0.5, 1.5).xyxy;
    vec4 s = vec4(xc.xz + xc.yw, yc.xz + yc.yw);
    vec4 o = (c + vec4(xc.yw, yc.yw) / s) / uMaskSize.xxyy;
    float s0 = texture2D(tex, o.xz).r;
    float s1 = texture2D(tex, o.yz).r;
    float s2 = texture2D(tex, o.xw).r;
    float s3 = texture2D(tex, o.yw).r;
    float sx = s.x / (s.x + s.y);
    float sy = s.z / (s.z + s.w);
    return mix(mix(s3, s2, sx), mix(s1, s0, sx), sy);
  }

  // Signed distance to the 0.5 contour in screen pixels -> ~1 px antialiased solid edge.
  // Must run in uniform control flow (fwidth); every call site branches on uMode only.
  float crisp(float conf) {
    return clamp((conf - 0.5) / max(fwidth(conf), 1e-4) + 0.5, 0.0, 1.0);
  }

  // Raw confidence of a region (person mask or hand matte) at a screen position.
  float regionConf(sampler2D person, vec2 screen) {
    vec2 src = toSource(screen);
    return max(maskBicubic(person, src), texture2D(uMatte, src).r);
  }

  vec3 camera(vec2 screen) {
    return sRGBTransferEOTF(texture2D(uVideo, toSource(screen))).rgb;
  }

  float hash(float n) { return fract(sin(n * 12.9898 + 78.233) * 43758.5453); }

  // ---- Effect 2 (Slices): deformed 10-row grid. Row lines move first; each row's column lines
  // move independently. Every boundary is bounded by SLICE_EDGE_AMP cells, so cells never invert.
  // Hand mirror of slices.js sliceWave / sliceEdge / sliceCell / sliceSource.
  float sliceWave(float id, float channel, float t) {
    float s = hash(id * 0.917 + channel * 4.13 + 0.61);
    float w1 = SLICE_FREQ_MIN + SLICE_FREQ_RANGE * fract(s * 7.31);
    float w2 = SLICE_FREQ_MIN + SLICE_FREQ_RANGE * fract(s * 13.17);
    float p1 = 6.28318 * fract(s * 3.91);
    float p2 = 6.28318 * fract(s * 5.77);
    return (sin(t * w1 + p1) + SLICE_HARMONIC * sin(t * w2 + p2)) / (1.0 + SLICE_HARMONIC);
  }

  float sliceEdge(float k, float n, float line, float t) {
    float inner = step(0.5, k) * step(k, n - 0.5);
    return (k + SLICE_EDGE_AMP * inner * sliceWave(line * SLICE_ID_STRIDE + k, 0.0, t)) / n;
  }

  // Deformed cell containing p: the row first, then the column lines of that row. Three candidates
  // each way; the true index is always one of them, because a boundary moves at most 0.4 cell.
  void sliceCell(vec2 p, float t, float cols, out float row, out float top, out float bot,
                 out float col, out float left, out float right) {
    float yy = min(max(p.y, 0.0), 0.999999);
    float j0 = clamp(floor(yy * SLICE_ROWS), 0.0, SLICE_ROWS - 1.0);
    row = j0;
    top = sliceEdge(j0, SLICE_ROWS, 0.0, t);
    bot = sliceEdge(j0 + 1.0, SLICE_ROWS, 0.0, t);
    for (int i = 0; i < 3; i++) {
      float j = clamp(j0 - 1.0 + float(i), 0.0, SLICE_ROWS - 1.0);
      float a = sliceEdge(j, SLICE_ROWS, 0.0, t);
      float b = sliceEdge(j + 1.0, SLICE_ROWS, 0.0, t);
      if (yy >= a && yy < b) { row = j; top = a; bot = b; }
    }
    float xx = min(max(p.x, 0.0), 0.999999);
    float k0 = clamp(floor(xx * cols), 0.0, cols - 1.0);
    col = k0;
    left = sliceEdge(k0, cols, 1.0 + row, t);
    right = sliceEdge(k0 + 1.0, cols, 1.0 + row, t);
    for (int i = 0; i < 3; i++) {
      float k = clamp(k0 - 1.0 + float(i), 0.0, cols - 1.0);
      float a = sliceEdge(k, cols, 1.0 + row, t);
      float b = sliceEdge(k + 1.0, cols, 1.0 + row, t);
      if (xx >= a && xx < b) { col = k; left = a; right = b; }
    }
  }

  // One slice cell: the camera content of its rest rectangle, stretched to the deformed cell and
  // shifted by the cell's own bounded offset. Returns the cell colour before the region gate.
  vec3 sliceTile(vec2 p, vec3 cam, float t) {
    float row, top, bot, col, left, right;
    sliceCell(p, t, uSliceCols, row, top, bot, col, left, right);
    float id = row * SLICE_ID_STRIDE + col;
    float u = (p.x - left) / (right - left);
    float v = (p.y - top) / (bot - top);
    vec2 src = vec2(
      (col + u + SLICE_CONTENT_AMP * sliceWave(id, 1.0, t)) / uSliceCols,
      (row + v + SLICE_CONTENT_AMP * sliceWave(id, 2.0, t)) / SLICE_ROWS);
    src = clamp(src, 0.0, 1.0);
    // Only camera content that is itself inside the region may move in; otherwise keep p.
    float keep = crisp(regionConf(uRawMask, src));
    vec3 tile = mix(cam, camera(src), keep);
    // Sparse 1 px white borders on a fixed subset of cells, measured on the deformed cell.
    vec2 edgePx = min(vec2(p.x - left, p.y - top), vec2(right - p.x, bot - p.y)) * uResolution;
    float line = clamp(1.0 - min(edgePx.x, edgePx.y), 0.0, 1.0);
    float bordered = step(hash(id * 8.29 + 0.6), 0.35);
    return mix(tile, vec3(1.0), line * bordered);
  }

  // ---- Effect 3 (Kaleidoscope): mirrored sectors about the effect centre. The sample is the camera at
  // r / KAL_MAG from the centre (a constant ~1.1x magnification), at an angle folded per sector and
  // twisted by the spiral and the slow spin. Samples past the frame edge are reflected back in, not
  // clamped. Samples may come from anywhere in the frame; only the silhouette gate limits the output.
  // Mirror of the sampling in tests/kaleidoscope.test.js.
  float reflectUnit(float x) { return 1.0 - abs(1.0 - mod(x, 2.0)); } // [0, 1] with period 2

  vec3 kaleidoscope(vec2 p, float t) {
    float aspect = uResolution.x / uResolution.y;
    vec2 d = vec2((p.x - uAnchor.x) * aspect, p.y - uAnchor.y);
    float r = length(d);
    vec2 dir = (r < 1e-5) ? vec2(1.0, 0.0) : d / r;
    float sector = 6.28318 / KAL_SECTORS;
    float f = abs(mod(atan(dir.y, dir.x) + KAL_ROT * t, sector) - 0.5 * sector); // mirror fold, [0, sector/2]
    float a = f + KAL_SPIRAL * r + KAL_SPIN * t;
    vec2 s = vec2(cos(a), sin(a)) * (r / KAL_MAG);
    vec2 q = uAnchor + vec2(s.x / aspect, s.y);
    return camera(vec2(reflectUnit(q.x), reflectUnit(q.y)));
  }

  // ---- Effect 4 (Ripple): radial wavefronts from the effect centre refract the live camera; the
  // crests are brightened so each front reads as a ring.
  vec3 ripples(vec2 p) {
    float aspect = uResolution.x / uResolution.y;
    vec2 d = vec2((p.x - uAnchor.x) * aspect, p.y - uAnchor.y);
    float r = length(d);
    vec2 dir = d / max(r, 1e-4); // finite at the centre: magnitude is r / 1e-4 there, so it stays bounded
    float wave = sin(RIP_K * r - RIP_W * uTime);
    vec2 q = p - vec2(dir.x / aspect, dir.y) * (RIP_AMP * wave);
    q = clamp(q, 0.0, 1.0);
    float crest = pow(max(wave, 0.0), 6.0);
    return camera(q) * (1.0 + RIP_CREST * crest);
  }

  // ---- Effect 5 (Code rain / digital): the silhouette is a grid of square cells, each showing a glyph from the
  // atlas. Colour and glyph come from the cell's grid position, time and column only: the camera is
  // never sampled here, so no photographic shape or tone can show. Each column runs a bright head
  // with a fading trail. Colour is a global palette state (mono or duo, held for DIGITAL_PALETTE_HOLD),
  // one hue per cell or one of two by a stable cell hash; each letter glints at its own phase. Opaque
  // inside the region. Hand mirror of digitalColour / digitalGlyph / headDistance in src/digital.js.
  vec3 digitalHue(float t, float pick) {
    float state = mod(floor(t / DIGITAL_PALETTE_HOLD), 4.0);
    if (state < 0.5) return DIGITAL_CYAN;
    if (state < 1.5) return pick < 0.5 ? DIGITAL_MAGENTA : DIGITAL_VIOLET;
    if (state < 2.5) return DIGITAL_AMBER;
    return pick < 0.5 ? DIGITAL_BLUE : DIGITAL_CYAN;
  }

  float digitalGlint(vec2 cell, float t) {
    float wave = 0.5 + 0.5 * sin(DIGITAL_GLINT_RATE * t + 6.28318 * hash(cell.x * 7.77 + cell.y * 2.13 + 0.61));
    return DIGITAL_GLINT_FLOOR + (1.0 - DIGITAL_GLINT_FLOOR) * pow(wave, 3.0);
  }

  float digitalHead(float col, float t) {
    float speed = DIGITAL_STREAM_MIN + DIGITAL_STREAM_RANGE * hash(col * 1.37 + 0.5);
    return fract(hash(col * 2.31 + 0.9) + speed * t);
  }

  vec3 digitalCode(vec2 p, float t) {
    vec2 g = vec2(p.x * uCodeGrid.x, p.y * uCodeGrid.y);
    vec2 cell = floor(g);
    vec2 local = fract(g);
    vec2 c = (cell + 0.5) / uCodeGrid; // cell centre: a position, not a camera sample
    float d = fract(digitalHead(cell.x, t) - c.y); // distance behind this column's head

    vec3 hue = digitalHue(t, hash(cell.x * 3.91 + cell.y * 17.13 + 0.37));
    hue *= hue; // display -> linear

    float level = (DIGITAL_TRAIL_FLOOR + (1.0 - DIGITAL_TRAIL_FLOOR) * exp(-DIGITAL_TRAIL * d)) * digitalGlint(cell, t);
    float head = exp(-DIGITAL_HEAD_SHARP * d); // the head reaches the full cell hue, never white
    vec3 glyphColour = hue * mix(level, 1.0, head);

    // One glyph change per ripple period; the per-row phase staggers the rows (see digitalGlyph in digital.js).
    float tick = floor(t / TEMPO_PERIOD + hash(cell.y * 0.37 + 0.11));
    float idx = floor(hash(cell.x * 12.9898 + cell.y * 78.233 + tick * 0.618) * GLYPH_COUNT);
    vec2 atlasCell = vec2(mod(idx, GLYPH_COLS), floor(idx / GLYPH_COLS));
    vec2 inCell = mix(vec2(GLYPH_PAD), vec2(1.0 - GLYPH_PAD), local);
    vec2 atlasUv = (atlasCell + inCell) / vec2(GLYPH_COLS, GLYPH_ROWS);
    float ink = textureLod(uGlyphs, atlasUv, uGlyphLod).r;
    // Opaque: the background is the cell hue, dark, never the camera.
    return mix(hue * DIGITAL_BG_LEVEL, glyphColour, ink);
  }

  // ---- Effect 6 (Void): the whole frame is a warm duotone. The background is the camera's luminance mapped
  // from deep brown to muted orange; the person (processed coverage, hand matte unioned) is a near-flat
  // saturated fill with slight luminance shading. Just outside the silhouette a warm halo comes from 8 binary
  // taps on a ring of VOID_HALO_R around the pixel: no blur pass. The halo pulses at the ripple rate RIP_W.
  // Output is display-referred colour squared to linear, like the fluid. Only mode 6 runs this.
  vec3 voidGrade(vec2 screen, vec3 cam, float region) {
    float aspect = uResolution.x / uResolution.y;
    float lum = pow(dot(cam, vec3(0.2126, 0.7152, 0.0722)), 0.45); // display-ish luminance, 0..1
    vec3 bg = mix(VOID_DARK, VOID_LIGHT, lum);
    vec3 fill = VOID_FILL * (0.88 + 0.12 * lum);
    float ring = 0.0;
    for (int i = 0; i < 8; i++) {
      float a = 0.78539816 * float(i);
      vec2 o = vec2(cos(a) / aspect, sin(a)) * VOID_HALO_R;
      ring += step(0.5, regionConf(uMask, screen + o));
    }
    ring /= 8.0;
    float pulse = 1.0 + VOID_PULSE * sin(RIP_W * uTime);
    vec3 display = mix(bg, fill, region) + VOID_GLOW * (ring * pulse * (1.0 - region));
    display = clamp(display, 0.0, 1.0);
    return display * display;
  }

  void main() {
    vec2 screen = vec2(vUv.x, 1.0 - vUv.y);
    vec3 cam = camera(screen);
    vec3 col = cam;
    float t = uTime;

    // Only the active mode's branch runs; every branch tests uMode, which is uniform.
    if (abs(uMode - ${glslFloat(MODE_INDEX.effect1)}) < 0.5) {
      if (uHasFluid > 0.5) {
        float region = crisp(regionConf(uMask, screen));
        vec3 fluid = shadeFluid(vUv);
        col = mix(cam, fluid, region);
      }
    } else if (abs(uMode - ${glslFloat(MODE_INDEX.effect2)}) < 0.5) {
      float region = crisp(regionConf(uRawMask, screen));
      col = mix(cam, sliceTile(screen, cam, t), region);
    } else if (abs(uMode - ${glslFloat(MODE_INDEX.effect3)}) < 0.5) {
      // Processed coverage: the same expanded silhouette as effect 1. The hand matte is still unioned in.
      float region = crisp(regionConf(uMask, screen));
      col = mix(cam, kaleidoscope(screen, t), region);
    } else if (abs(uMode - ${glslFloat(MODE_INDEX.effect4)}) < 0.5) {
      float region = crisp(regionConf(uMask, screen));
      col = mix(cam, ripples(screen), region);
    } else if (abs(uMode - ${glslFloat(MODE_INDEX.effect5)}) < 0.5) {
      float region = crisp(regionConf(uRawMask, screen));
      col = mix(cam, digitalCode(screen, t), region);
    } else if (abs(uMode - ${glslFloat(MODE_INDEX.effect6)}) < 0.5) {
      // Whole-frame grade: the background is graded too, so the region only picks fill or background.
      float region = crisp(regionConf(uMask, screen));
      col = voidGrade(screen, cam, region);
    }
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

function createQuad() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const mesh = new THREE.Mesh(geometry);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  const camera = new THREE.Camera();
  return {
    draw(renderer, material, target) {
      mesh.material = material;
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
    },
    dispose() { geometry.dispose(); },
  };
}

function isMobile() {
  return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) || matchMedia('(pointer: coarse)').matches;
}

/** Throws if WebGL2 is unavailable. `fluid` is null if float render targets aren't supported. */
export function createView({ host, video, onContextLost, onContextRestored, onError }) {
  const mobile = isMobile();
  const canvas = document.createElement('canvas');
  host.appendChild(canvas);

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
    });
  } catch (err) {
    canvas.remove();
    throw err;
  }
  renderer.autoClear = false;
  renderer.debug.checkShaderErrors = true;
  renderer.debug.onShaderError = (gl, program, vs, fs) => {
    const log = [
      `VS: ${gl.getShaderInfoLog(vs) || ''}`,
      `FS: ${gl.getShaderInfoLog(fs) || ''}`,
      `Program: ${gl.getProgramInfoLog(program) || ''}`,
    ].join('\n');
    console.error('Shader compile/link failed\n' + log);
    onError?.(new Error(log));
  };
  renderer.setPixelRatio(mobile ? 1 : Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;

  const quad = createQuad();
  const fluid = createFluid(renderer, quad, mobile ? 256 : 320);

  const videoTexture = new THREE.VideoTexture(video);
  videoTexture.colorSpace = THREE.SRGBColorSpace;
  videoTexture.minFilter = THREE.LinearFilter;
  videoTexture.magFilter = THREE.LinearFilter;
  videoTexture.generateMipmaps = false;
  videoTexture.flipY = false;

  // One-channel byte texture. Rows are tightly packed, so the alignment must be 1 for any width.
  const makeMaskTexture = (w, h, data) => {
    const tex = new THREE.DataTexture(data, w, h, THREE.RedFormat, THREE.UnsignedByteType);
    tex.unpackAlignment = 1;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  };
  // Processed coverage (effects 1, 3, 4 and 6) and raw segmenter output (effects 2 and 5) are separate buffers.
  // The processed path is: raw -> persistence (held enclosed dropouts) -> coverage (dilation, holes)
  // -> pose capsules (union). The raw path is the segmenter output, untouched.
  let maskBytes = new Uint8Array(1);
  let rawMaskBytes = new Uint8Array(1);
  let heldBytes = new Uint8Array(1);
  let maskTexture = makeMaskTexture(1, 1, maskBytes);
  let rawMaskTexture = makeMaskTexture(1, 1, rawMaskBytes);
  let coverage = createCoverage(1, 1);
  let persistence = createMaskPersistence(1, 1);
  let poseCapsulePx = 0;
  // Latest pose sample ({ sampledAt, frameTime, poses }) from ml.js or the test mode. Freshness is
  // judged against each segmentation result's own timestamp (see pose-capsules.js).
  let latestPose = null;
  let maskAt = -Infinity;
  // Effect centre in source-normalized coordinates; null until the first non-empty mask.
  let anchorSrc = null;
  let matteBytes = new Uint8Array(1);
  let matteTexture = makeMaskTexture(1, 1, matteBytes);
  let matteEmpty = true;

  // Digital-code atlas: drawn once, mipmapped, row 0 at the top (flipY off), so cell rows index it directly.
  const glyphTexture = new THREE.CanvasTexture(drawGlyphAtlas(document.createElement('canvas')));
  glyphTexture.flipY = false;
  glyphTexture.generateMipmaps = true;
  glyphTexture.minFilter = THREE.LinearMipmapLinearFilter;
  glyphTexture.magFilter = THREE.LinearFilter;
  glyphTexture.needsUpdate = true;

  const uniforms = {
    uVideo: { value: videoTexture },
    uMask: { value: maskTexture },
    uRawMask: { value: rawMaskTexture },
    uMatte: { value: matteTexture },
    uFluid: { value: null },
    uGlyphs: { value: glyphTexture },
    uCrop: { value: new THREE.Vector4(0, 0, 1, 1) },
    uMaskSize: { value: new THREE.Vector2(1, 1) },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uFluidTexel: { value: new THREE.Vector2() },
    uHasFluid: { value: fluid ? 1 : 0 },
    uMode: { value: 0 },
    uTime: { value: 0 },
    uAnchor: { value: new THREE.Vector2(0.5, 0.5) },
    uSliceCols: { value: SLICE_ROWS },
    uCodeGrid: { value: new THREE.Vector2(1, DIGITAL_ROWS) },
    uGlyphLod: { value: 0 },
  };
  const compositeMat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: COMPOSITE_FRAG,
    uniforms,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
  });

  let contextLost = false;
  const handleLost = (event) => {
    event.preventDefault();
    contextLost = true;
    onContextLost?.();
  };
  const handleRestored = () => {
    contextLost = false;
    fluid?.invalidate();
    maskTexture.needsUpdate = true;
    rawMaskTexture.needsUpdate = true;
    matteTexture.needsUpdate = true;
    glyphTexture.needsUpdate = true;
    onContextRestored?.();
  };
  canvas.addEventListener('webglcontextlost', handleLost);
  canvas.addEventListener('webglcontextrestored', handleRestored);

  const size = { w: 0, h: 0 };
  function resize(w, h) {
    if (w <= 0 || h <= 0) return;
    size.w = w;
    size.h = h;
    renderer.setSize(w, h, false);
    renderer.getDrawingBufferSize(uniforms.uResolution.value);
    fluid?.resize(w, h);
  }

  /**
   * Copies the mask out of MediaPipe-owned memory; the caller may close it right after. Keeps the
   * raw bytes for effects 2 and 5, builds the processed coverage for effects 1, 3 and 4 (persistence,
   * then coverage, then fresh pose capsules), and updates the effect centre from the raw mask.
   * `at` is the segmentation result's own timestamp (performance.now clock); it drives the hold.
   */
  function setMask(float32, w, h, at = performance.now()) {
    if (maskTexture.image.width !== w || maskTexture.image.height !== h) {
      maskTexture.dispose();
      rawMaskTexture.dispose();
      maskBytes = new Uint8Array(w * h);
      rawMaskBytes = new Uint8Array(w * h);
      heldBytes = new Uint8Array(w * h);
      coverage = createCoverage(w, h);
      persistence = createMaskPersistence(w, h);
      maskTexture = makeMaskTexture(w, h, maskBytes);
      rawMaskTexture = makeMaskTexture(w, h, rawMaskBytes);
      uniforms.uMask.value = maskTexture;
      uniforms.uRawMask.value = rawMaskTexture;
      uniforms.uMaskSize.value.set(w, h);
    }
    for (let i = 0; i < rawMaskBytes.length; i++) {
      const v = float32[i];
      rawMaskBytes[i] = v <= 0 ? 0 : v >= 1 ? 255 : v * 255 + 0.5;
    }
    persistence.update(rawMaskBytes, at, heldBytes);
    coverage.run(heldBytes, maskBytes);
    const pose = poseFresh(latestPose, at);
    poseCapsulePx = pose ? paintPose(pose.poses, w, h, maskBytes) : 0;
    const centroid = maskCentroid(rawMaskBytes, w, h);
    if (centroid) anchorSrc = anchorSrc ? smoothAnchor(anchorSrc, centroid, ANCHOR_ALPHA) : centroid;
    maskAt = performance.now();
    maskTexture.needsUpdate = true;
    rawMaskTexture.needsUpdate = true;
  }

  /**
   * Drops the person mask, its persistence memory, the pose and the anchor. Called when the camera
   * input changes or stops, so the previous feed's silhouette can't shape the next one. The next
   * segmentation result restores it.
   */
  function clearMask() {
    maskBytes.fill(0);
    rawMaskBytes.fill(0);
    heldBytes.fill(0);
    persistence.reset();
    poseCapsulePx = 0;
    latestPose = null;
    maskTexture.needsUpdate = true;
    rawMaskTexture.needsUpdate = true;
    anchorSrc = null;
    maskAt = -Infinity;
  }

  /** Latest pose sample, or null. Only the processed coverage reads it. Does no CPU work by itself. */
  function setPose(sample) {
    latestPose = sample ?? null;
  }

  /**
   * Rebuilds the hand matte from source-space landmarks (21 points per hand). An empty list
   * clears it on the same frame, so a lost or stale hand leaves no phantom.
   */
  function setHands(hands) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;
    const scale = MATTE_SHORT_SIDE / Math.min(vw, vh);
    const w = Math.max(1, Math.round(vw * scale));
    const h = Math.max(1, Math.round(vh * scale));
    if (matteTexture.image.width !== w || matteTexture.image.height !== h) {
      matteTexture.dispose();
      matteBytes = new Uint8Array(w * h);
      matteTexture = makeMaskTexture(w, h, matteBytes);
      uniforms.uMatte.value = matteTexture;
      matteEmpty = true;
    }
    if (!hands.length && matteEmpty) return;
    matteEmpty = !rasterizeHands(hands, w, h, matteBytes, MATTE_FEATHER_PX);
    matteTexture.needsUpdate = true;
  }

  let lastNow = null;
  function render(now, state, crop) {
    if (contextLost || size.w === 0) return;
    const dt = lastNow === null ? 0 : Math.min(1 / 30, (now - lastNow) / 1000);
    lastNow = now;

    // The fluid only advects while it is visible; its field is kept, not reset.
    if (fluid && state.mode === 'effect1') {
      fluid.step(dt);
      uniforms.uFluid.value = fluid.texture;
      const texel = fluid.texelSize;
      uniforms.uFluidTexel.value.set(texel.x, texel.y);
    }
    uniforms.uCrop.value.set(crop.x, crop.y, crop.w, crop.h);
    uniforms.uMode.value = MODE_INDEX[state.mode] ?? 0;
    // Not reset on selection or wrapped, so the motion of the slices and radial effects never snaps.
    uniforms.uTime.value = now / 1000;

    const res = uniforms.uResolution.value;
    const aspect = res.x / res.y;
    uniforms.uSliceCols.value = sliceColumns(aspect);
    uniforms.uCodeGrid.value.set(digitalColumns(aspect), DIGITAL_ROWS);
    // Device pixels per digital cell; the mip level keeps the 64 px glyphs from aliasing.
    uniforms.uGlyphLod.value = Math.max(0, Math.log2(GLYPH_CELL_PX / (res.y / DIGITAL_ROWS)));
    const anchor = sourceToScreen(anchorSrc?.x ?? 0.5, anchorSrc?.y ?? 0.5, crop);
    uniforms.uAnchor.value.set(anchor.x, anchor.y);

    quad.draw(renderer, compositeMat, null);
  }

  function dispose() {
    canvas.removeEventListener('webglcontextlost', handleLost);
    canvas.removeEventListener('webglcontextrestored', handleRestored);
    fluid?.dispose();
    videoTexture.dispose();
    maskTexture.dispose();
    rawMaskTexture.dispose();
    matteTexture.dispose();
    glyphTexture.dispose();
    compositeMat.dispose();
    quad.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
  }

  return {
    resize,
    setMask,
    clearMask,
    setPose,
    setHands,
    render,
    dispose,
    /** Milliseconds since the last mask upload, at `now` (performance.now clock). */
    maskAge: (now) => now - maskAt,
    /** Diagnostics of the last processed mask: pixels filled by a hold, and pose capsule pixels raised. */
    maskStats: () => ({ heldPx: persistence.heldPx, poseCapsulePx }),
    fluidType: fluid ? fluid.typeName : null,
  };
}
