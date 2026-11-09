import * as THREE from 'three';

// Screen-space dye advection (not a physical solver, not body-attached).
// Field channels: RG = (cos, sin) of an advected phase, so interpolation never hits a
// wrap-around seam; B = advected film thickness. Velocity is the curl of an analytic
// streamfunction, so it is divergence-free and needs no pressure solve.

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const SOURCE_GLSL = /* glsl */ `
  uniform float uAspect;
  uniform float uTime;
  // Broad rainbow bands, drifting very slowly.
  vec3 bands(vec2 uv, float t) {
    vec2 p = vec2(uv.x * uAspect, uv.y);
    float a = p.x * 0.8 + p.y * 1.1 + t * 0.012
      + 0.22 * sin(p.y * 2.1 + t * 0.07 + 1.5 * sin(p.x * 1.3 - t * 0.05));
    float phase = 6.28318 * a;
    float h = 0.5 + 0.5 * sin(p.x * 2.6 - p.y * 1.9 + t * 0.09);
    return vec3(cos(phase), sin(phase), h);
  }
`;

const SEED_FRAG = /* glsl */ `
  varying vec2 vUv;
  ${SOURCE_GLSL}
  void main() { gl_FragColor = vec4(bands(vUv, uTime), 1.0); }
`;

const COPY_FRAG = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D uField;
  void main() { gl_FragColor = texture2D(uField, vUv); }
`;

const ADVECT_FRAG = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D uField;
  uniform vec2 uRes;
  uniform float uDt;
  ${SOURCE_GLSL}

  float wall(float x, float len) {
    return smoothstep(0.0, 0.12, x) * smoothstep(0.0, 0.12, len - x);
  }

  // Multiple moving gaussian vortices + gentle low-frequency noise. Fading to zero at
  // the walls gives zero normal flow there, so nothing streaks in from the clamped edge.
  float psi(vec2 p, float t) {
    float s = 0.0;
    for (int i = 0; i < 6; i++) {
      float fi = float(i);
      vec2 c = vec2(
        uAspect * (0.5 + 0.42 * sin(t * (0.11 + 0.023 * fi) + fi * 1.7)),
        0.5 + 0.42 * sin(t * (0.09 + 0.031 * fi) + fi * 2.9 + 1.0));
      float sigma = 0.15 + 0.025 * fi;
      float strength = (mod(fi, 2.0) < 0.5 ? 1.0 : -1.0) * (0.034 + 0.008 * sin(t * 0.17 + fi * 1.3));
      vec2 d = p - c;
      s += strength * exp(-dot(d, d) / (2.0 * sigma * sigma));
    }
    s += 0.006 * sin(p.x * 5.3 + t * 0.21 + 1.4 * sin(p.y * 4.1 - t * 0.13)) * cos(p.y * 6.1 - t * 0.17);
    return s * wall(p.x, uAspect) * wall(p.y, 1.0);
  }

  vec2 velocity(vec2 p, float t) {
    const float e = 0.004;
    float dx = psi(p + vec2(e, 0.0), t) - psi(p - vec2(e, 0.0), t);
    float dy = psi(p + vec2(0.0, e), t) - psi(p - vec2(0.0, e), t);
    return vec2(dy, -dx) / (2.0 * e);
  }

  vec4 catmullRom(float f) {
    float f2 = f * f, f3 = f2 * f;
    return 0.5 * vec4(-f3 + 2.0 * f2 - f, 3.0 * f3 - 5.0 * f2 + 2.0, -3.0 * f3 + 4.0 * f2 + f, f3 - f2);
  }

  // Bicubic lookup, limited to the surrounding texels so it can't ring or overshoot.
  vec3 sampleField(vec2 uv) {
    vec2 st = uv * uRes - 0.5;
    vec2 base = floor(st);
    vec4 wx = catmullRom(st.x - base.x);
    vec4 wy = catmullRom(st.y - base.y);
    ivec2 hi = ivec2(uRes) - 1;
    vec3 sum = vec3(0.0), lo = vec3(1e9), up = vec3(-1e9);
    for (int j = 0; j < 4; j++) {
      for (int i = 0; i < 4; i++) {
        vec3 s = texelFetch(uField, clamp(ivec2(base) + ivec2(i - 1, j - 1), ivec2(0), hi), 0).rgb;
        sum += s * wx[i] * wy[j];
        if (i >= 1 && i <= 2 && j >= 1 && j <= 2) { lo = min(lo, s); up = max(up, s); }
      }
    }
    return clamp(sum, lo, up);
  }

  void main() {
    vec2 p = vec2(vUv.x * uAspect, vUv.y);
    vec2 v1 = velocity(p, uTime);
    vec2 v2 = velocity(p - 0.5 * uDt * v1, uTime);
    vec2 q = p - uDt * v2;
    vec3 c = sampleField(vec2(q.x / uAspect, q.y));

    // Numerical mixing shrinks the phase vector; ease it back towards unit length to keep
    // the bands saturated. Bounded near zero so phase singularities don't amplify noise.
    float r = length(c.rg);
    float target = r + (1.0 - r) * (1.0 - exp(-uDt * 0.6)) * smoothstep(0.02, 0.15, r);
    c.rg *= target / max(r, 1e-3);

    // Slow replenishment of broad bands.
    c = mix(c, bands(vUv, uTime), 1.0 - exp(-uDt * 0.05));
    gl_FragColor = vec4(c, 1.0);
  }
`;

function dimensions(viewW, viewH, shortSide) {
  const aspect = viewW / viewH;
  const w = aspect >= 1 ? Math.min(1024, Math.round(shortSide * aspect)) : shortSide;
  const h = aspect >= 1 ? shortSide : Math.min(1024, Math.round(shortSide / aspect));
  return { w, h };
}

/** Returns 'half-float', 'float', or null when no filterable renderable float format exists. */
function detectType(renderer) {
  const gl = renderer.getContext();
  const candidates = [
    { name: 'half-float', type: THREE.HalfFloatType, ok: gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float') },
    { name: 'float', type: THREE.FloatType, ok: gl.getExtension('EXT_color_buffer_float') && gl.getExtension('OES_texture_float_linear') },
  ];
  for (const c of candidates) {
    if (!c.ok) continue;
    const rt = new THREE.WebGLRenderTarget(4, 4, { type: c.type, depthBuffer: false });
    renderer.setRenderTarget(rt);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    renderer.setRenderTarget(null);
    rt.dispose();
    if (complete) return c;
  }
  return null;
}

export function createFluid(renderer, quad, shortSide) {
  const format = detectType(renderer);
  if (!format) return null;

  const shared = { uAspect: { value: 1 }, uTime: { value: 0 } };
  const material = (fragmentShader, uniforms = {}) =>
    new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader,
      uniforms: { ...shared, ...uniforms },
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });

  const seedMat = material(SEED_FRAG);
  const copyMat = material(COPY_FRAG, { uField: { value: null } });
  const advectMat = material(ADVECT_FRAG, {
    uField: { value: null },
    uRes: { value: new THREE.Vector2() },
    uDt: { value: 0 },
  });

  const makeTarget = (w, h) =>
    new THREE.WebGLRenderTarget(w, h, {
      type: format.type,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      generateMipmaps: false,
    });

  let read = null;
  let write = null;
  let needsSeed = true;

  function seed() {
    quad.draw(renderer, seedMat, read);
    needsSeed = false;
  }

  function resize(viewW, viewH) {
    const { w, h } = dimensions(viewW, viewH, shortSide);
    shared.uAspect.value = viewW / viewH;
    if (read && read.width === w && read.height === h) return;
    const next = makeTarget(w, h);
    if (read && !needsSeed) {
      // Carry the existing field over; a resize must not restart the fluid.
      copyMat.uniforms.uField.value = read.texture;
      quad.draw(renderer, copyMat, next);
    }
    read?.dispose();
    write?.dispose();
    read = next;
    write = makeTarget(w, h);
    advectMat.uniforms.uRes.value.set(w, h);
  }

  function step(dt) {
    if (needsSeed) seed();
    shared.uTime.value += dt;
    advectMat.uniforms.uField.value = read.texture;
    advectMat.uniforms.uDt.value = dt;
    quad.draw(renderer, advectMat, write);
    [read, write] = [write, read];
  }

  return {
    typeName: format.name,
    resize,
    step,
    get texture() { return read.texture; },
    get texelSize() { return { x: 1 / read.width, y: 1 / read.height }; },
    get time() { return shared.uTime.value; },
    invalidate() { needsSeed = true; },
    dispose() {
      read?.dispose();
      write?.dispose();
      seedMat.dispose();
      copyMat.dispose();
      advectMat.dispose();
    },
  };
}
