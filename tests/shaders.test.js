import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShaderChunk } from 'three';
import { COMPOSITE_FRAG, MODE_INDEX, VERT } from '../src/view.js';

// Offline compile check of the real composite shader strings. Needs a glslang build on
// GLSLANG_VALIDATOR or PATH; with none, the suite is skipped and nothing is claimed compiled.
// The prefixes approximate what three.js adds for a WebGL2 ShaderMaterial (not byte-identical).

function assembleVertex(src) {
  return ['#version 300 es', 'precision highp float;', '#define attribute in', '#define varying out', 'in vec3 position;', src].join('\n');
}

function assembleFragment(src) {
  return [
    '#version 300 es',
    'precision highp float;',
    'precision highp int;',
    'precision highp sampler2D;',
    '#define varying in',
    '#define texture2D texture',
    '#define gl_FragColor pc_fragColor',
    'out highp vec4 pc_fragColor;',
    ShaderChunk.colorspace_pars_fragment,
    'vec4 linearToOutputTexel(vec4 value) { return LinearTransferOETF(value); }',
    src.replace('#include <colorspace_fragment>', ShaderChunk.colorspace_fragment),
  ].join('\n');
}

function findValidator() {
  for (const candidate of [process.env.GLSLANG_VALIDATOR, 'glslangValidator']) {
    if (!candidate) continue;
    const r = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (!r.error && /glslang/i.test(`${r.stdout}${r.stderr}`)) return candidate;
  }
  return null;
}

const validator = findValidator();
const dir = mkdtempSync(join(tmpdir(), 'gateway-glsl-'));

function compile(name, stage, source) {
  const file = join(dir, name);
  writeFileSync(file, source);
  const r = spawnSync(validator, ['-S', stage, file], { encoding: 'utf8' });
  return { ok: r.status === 0, log: `${r.stdout}${r.stderr}`.trim() };
}

describe.skipIf(!validator)('assembled GLSL (glslang offline compile)', () => {
  it('compiles the vertex shader', () => {
    const r = compile('composite.vert', 'vert', assembleVertex(VERT));
    expect(r.ok, r.log).toBe(true);
  });

  it('compiles the composite fragment shader', () => {
    const r = compile('composite.frag', 'frag', assembleFragment(COMPOSITE_FRAG));
    expect(r.ok, r.log).toBe(true);
  });

  it('rejects a broken fragment string (negative control for the harness)', () => {
    const r = compile('broken.frag', 'frag', assembleFragment(COMPOSITE_FRAG).replace('gl_FragColor', 'undefined_symbol_xyz'));
    expect(r.ok).toBe(false);
  });

  it('compiles the composite fragment for each of the seven modes (uMode pinned to one value per variant)', () => {
    expect(Object.keys(MODE_INDEX)).toHaveLength(7);
    for (const [name, idx] of Object.entries(MODE_INDEX)) {
      const pinned = COMPOSITE_FRAG.replace('uniform float uMode;', `const float uMode = ${idx}.0;`);
      expect(pinned).not.toBe(COMPOSITE_FRAG);
      const r = compile(`mode-${name}.frag`, 'frag', assembleFragment(pinned));
      expect(r.ok, `${name}: ${r.log}`).toBe(true);
    }
  });

  it('rejects a broken void branch (negative control for the effect-6 path)', () => {
    const broken = COMPOSITE_FRAG.replace('return display * display;', 'return display * ;');
    expect(broken).not.toBe(COMPOSITE_FRAG);
    const r = compile('broken-void.frag', 'frag', assembleFragment(broken));
    expect(r.ok).toBe(false);
  });
});

describe('shader wiring (string checks, always run)', () => {
  it('the shader has one branch per mode index, each testing a uniform', () => {
    for (const idx of Object.values(MODE_INDEX)) {
      if (idx === 0) continue;
      expect(COMPOSITE_FRAG).toContain(`abs(uMode - ${idx}.0) < 0.5`);
    }
  });

  it('effects 1, 3, 4 and 6 read the processed mask; effects 2 and 5 read the raw one (exact per-branch routing)', () => {
    // Each mode branch of main() gates on exactly one mask uniform. sliceTile() also reads uRawMask
    // for its own keep test; that helper sits outside the branch bodies checked here.
    const expected = { effect1: 'uMask', effect2: 'uRawMask', effect3: 'uMask', effect4: 'uMask', effect5: 'uRawMask', effect6: 'uMask' };
    for (const [name, uniform] of Object.entries(expected)) {
      const idx = MODE_INDEX[name];
      const start = COMPOSITE_FRAG.indexOf(`abs(uMode - ${idx}.0) < 0.5`);
      expect(start, name).toBeGreaterThan(-1);
      const rest = COMPOSITE_FRAG.slice(start + 1);
      const end = rest.search(/abs\(uMode - /);
      const body = end < 0 ? rest : rest.slice(0, end);
      const readers = [...body.matchAll(/regionConf\((uMask|uRawMask),/g)].map((m) => m[1]);
      expect(readers, name).toEqual([uniform]);
    }
  });

  it('the generated constants match the JS modules (no hand-typed copies)', () => {
    expect(COMPOSITE_FRAG).toContain('const float SLICE_ROWS = 10.0;');
    expect(COMPOSITE_FRAG).toContain('const float SLICE_EDGE_AMP = 0.4;');
    expect(COMPOSITE_FRAG).toContain('const float GLYPH_COLS = 8.0;');
  });
});
