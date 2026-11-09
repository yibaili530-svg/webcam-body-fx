// ?test=1 only, loaded through a dynamic import. Synthetic video + mask + hands that feed
// the same video element, mask upload and pinch logic as the real pipeline. Everything drawn
// here is labelled SYNTHETIC; nothing is read from a real camera.
import { TARGETS } from './gesture.js';
import { DOUBLE_WINDOW_MS } from './modes.js';

const VIDEO_W = 1280;
const VIDEO_H = 720;
const MASK_W = 256;
const MASK_H = 144;
const MASK_INTERVAL_MS = 33;
// Synthetic hand samples arrive on a detector-like cadence, not per render frame. A pinch script
// therefore produces a sample every interval, and each one goes through the real pinch detector.
const HAND_INTERVAL_MS = 33;

// SYNTHETIC pinch timelines: thumb-index distance ratio (over the hand scale) against time since the
// script was chosen. A script holds its last value once it ends. Keyframes are [ms, ratio].
// - single: one pinch (fast close, release). Early fire may come just before the close sample.
// - double: two pinches about 280 ms apart, inside DOUBLE_WINDOW_MS, so the second cancels.
// - near: approaches to 0.41 and stops above the close threshold. Must not fire.
// - slow: a slow close with no approach speed to predict from. Only the real close fires.
export const PINCH_SCRIPTS = {
  open: [[0, 0.9]],
  single: [[0, 0.9], [500, 0.9], [600, 0.15], [700, 0.15], [800, 0.9]],
  double: [[0, 0.9], [400, 0.9], [480, 0.15], [560, 0.15], [640, 0.9], [700, 0.9], [780, 0.15], [860, 0.15], [940, 0.9]],
  near: [[0, 0.9], [300, 0.6], [450, 0.45], [550, 0.42], [700, 0.41]],
  slow: [[0, 0.9], [300, 0.9], [1100, 0.2], [1400, 0.2], [1700, 0.9]],
};

/** Ratio of a script at `ms` after its start: linear between keyframes, held at the ends. */
export function pinchRatioAt(keys, ms) {
  if (ms <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [t1, r1] = keys[i];
    if (ms <= t1) {
      const [t0, r0] = keys[i - 1];
      return r0 + ((r1 - r0) * (ms - t0)) / (t1 - t0);
    }
  }
  return keys[keys.length - 1][1];
}


// Deliberate QA defects, so RAW and processed masks visibly differ:
// - the mask is narrower than the drawn body (undercoverage on both sides), so the processed
//   coverage (4 px dilation) has real work to do;
// - a small hole in the torso that the processed coverage fills (area well under 400 px).
const BODY_MASK_SCALE = 0.8;
const HOLE = { x: 0.5, y: 0.7, r: 0.04 }; // r is a fraction of the frame height

// SYNTHETIC additions, labelled as such. A transient dropout is one mask update every 3 s, a disc of
// 5 mask px inside the body. It is enclosed, so the processed coverage holds it (persistence); the raw
// mask keeps it, which is the visible difference between effects 1 and 2 for that update.
const DROPOUT_PERIOD_MS = 3000;
const DROPOUT_RADIUS_PX = 5;
// SYNTHETIC pose sample, refreshed at a pose-like cadence. Torso and head sit inside the drawn body.
// The limbs are reported with low visibility, so the capsule gate must leave them out.
const POSE_INTERVAL_MS = 100;

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// Source-space person geometry, normalized to the frame (u across width, v down height).
function personShapes(now) {
  const t = now / 1000;
  const cx = 0.5 + 0.18 * Math.sin(t * 0.6);
  return {
    head: { x: cx, y: 0.3 + 0.02 * Math.sin(t * 1.3), rx: 0.09, ry: 0.17 },
    body: { x: cx, y: 0.85, rx: 0.2, ry: 0.42 },
  };
}

function drawPattern(ctx, now) {
  const t = now / 1000;
  const grad = ctx.createLinearGradient(0, 0, VIDEO_W, VIDEO_H);
  grad.addColorStop(0, '#26303a');
  grad.addColorStop(1, '#4a4238');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, VIDEO_W, VIDEO_H);

  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= VIDEO_W; x += 80) { ctx.moveTo(x, 0); ctx.lineTo(x, VIDEO_H); }
  for (let y = 0; y <= VIDEO_H; y += 80) { ctx.moveTo(0, y); ctx.lineTo(VIDEO_W, y); }
  ctx.stroke();

  ctx.fillStyle = '#e8c547';
  ctx.beginPath();
  ctx.arc(VIDEO_W * (0.5 + 0.4 * Math.sin(t * 0.7)), VIDEO_H * (0.5 + 0.35 * Math.cos(t * 1.1)), 40, 0, Math.PI * 2);
  ctx.fill();

  drawPerson(ctx, now);

  // Written unmirrored into the source, so the mirror is visible on screen.
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.font = '48px sans-serif';
  ctx.fillText('SOURCE-LEFT', 40, 70);
  ctx.textAlign = 'right';
  ctx.fillText('SOURCE-RIGHT', VIDEO_W - 40, 70);
  ctx.textAlign = 'left';
  ctx.font = 'bold 36px ui-monospace, Menlo, monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillText('SYNTHETIC', 40, VIDEO_H - 36);
}

// A textured person: diagonal stripes whose phase, colour and a moving checker change over time,
// so any warp of the content is visible. Clipped to the same ellipses the mask is drawn from.
function drawPerson(ctx, now) {
  const t = now / 1000;
  const { head, body } = personShapes(now);
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(head.x * VIDEO_W, head.y * VIDEO_H, head.rx * VIDEO_W, head.ry * VIDEO_H, 0, 0, Math.PI * 2);
  ctx.ellipse(body.x * VIDEO_W, body.y * VIDEO_H, body.rx * VIDEO_W, body.ry * VIDEO_H, 0, 0, Math.PI * 2);
  ctx.clip();

  ctx.fillStyle = '#c98f6b';
  ctx.fillRect(0, 0, VIDEO_W, VIDEO_H);
  const period = 64;
  const shift = (t * 90) % (period * 2);
  for (let x = -VIDEO_H - period * 2; x < VIDEO_W + period * 2; x += period) {
    const hue = (x / period + t * 0.4) % 3;
    ctx.fillStyle = hue < 1 ? '#2d5f8a' : hue < 2 ? '#e8e0d0' : '#8a3b3b';
    ctx.beginPath();
    ctx.moveTo(x + shift, 0);
    ctx.lineTo(x + shift + period * 0.5, 0);
    ctx.lineTo(x + shift + period * 0.5 - VIDEO_H * 0.5, VIDEO_H);
    ctx.lineTo(x + shift - VIDEO_H * 0.5, VIDEO_H);
    ctx.closePath();
    ctx.fill();
  }
  // Moving checker, so single-cell edges are easy to see in the output.
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  const cell = 24;
  const ox = (t * 40) % (cell * 2);
  for (let y = 0; y < VIDEO_H; y += cell) {
    for (let x = -cell * 2 + ox; x < VIDEO_W; x += cell * 2) {
      ctx.fillRect(x + ((y / cell) % 2) * cell, y, cell, cell);
    }
  }
  ctx.restore();
}

// Draws the spread hand on the video. Only called when the silhouette hand is held, so it is
// always matted at the same time: a visible hand the matte misses would be a false test result.
function drawHand(ctx, lm) {
  const px = (p) => ({ x: p.x * VIDEO_W, y: p.y * VIDEO_H });
  ctx.save();
  ctx.fillStyle = '#e0a47e';
  ctx.strokeStyle = '#e0a47e';
  ctx.lineCap = 'round';
  ctx.lineWidth = 0.035 * VIDEO_H;
  const palm = [0, 5, 9, 13, 17].map((i) => px(lm[i]));
  ctx.beginPath();
  palm.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.fill();
  for (const chain of [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]]) {
    ctx.beginPath();
    chain.forEach((i, k) => {
      const p = px(lm[i]);
      if (k) ctx.lineTo(p.x, p.y);
      else ctx.moveTo(p.x, p.y);
    });
    ctx.stroke();
  }
  ctx.restore();
}

function writeMask(data, now, dropout = null) {
  const { head, body } = personShapes(now);
  const bodyMask = { ...body, rx: body.rx * BODY_MASK_SCALE };
  const inside = (e, u, v) => {
    const dx = (u - e.x) / e.rx;
    const dy = (v - e.y) / e.ry;
    return 1 - smooth(0.85, 1.1, Math.sqrt(dx * dx + dy * dy));
  };
  // Hole in source aspect: radius is a fraction of the frame height, so it stays round.
  const holeR2 = (HOLE.r * HOLE.r);
  for (let y = 0, i = 0; y < MASK_H; y++) {
    const v = (y + 0.5) / MASK_H;
    for (let x = 0; x < MASK_W; x++, i++) {
      const u = (x + 0.5) / MASK_W;
      const du = (u - HOLE.x) * (VIDEO_W / VIDEO_H);
      const dv = v - HOLE.y;
      if (du * du + dv * dv < holeR2) {
        data[i] = 0;
        continue;
      }
      data[i] = Math.max(inside(head, u, v), inside(bodyMask, u, v));
      // SYNTHETIC transient dropout (see DROPOUT_PERIOD_MS): a small disc in pixels.
      if (dropout && (x + 0.5 - dropout.x) ** 2 + (y + 0.5 - dropout.y) ** 2 < DROPOUT_RADIUS_PX ** 2) data[i] = 0;
    }
  }
}

/** SYNTHETIC 33-point pose of the drawn person: torso, head and neck visible; limbs low visibility. */
function syntheticPose(now) {
  const { head } = personShapes(now);
  const cx = head.x;
  const lm = Array.from({ length: 33 }, () => ({ x: cx, y: 0.5, visibility: 0.2, presence: 0.2 }));
  const set = (i, x, y, visibility = 0.95) => {
    lm[i] = { x, y, visibility, presence: visibility };
  };
  set(0, cx, head.y); // nose
  set(11, cx - 0.11, 0.5); // left shoulder
  set(12, cx + 0.11, 0.5); // right shoulder
  set(23, cx - 0.15, 0.98); // left hip
  set(24, cx + 0.15, 0.98); // right hip
  // Limbs the drawn person does not show: reported, but below the gate, so they must not be drawn.
  set(13, cx - 0.3, 0.62, 0.2); set(14, cx + 0.3, 0.62, 0.2);
  set(15, cx - 0.36, 0.75, 0.2); set(16, cx + 0.36, 0.75, 0.2);
  set(25, cx - 0.14, 1.1, 0.2); set(26, cx + 0.14, 1.1, 0.2);
  return lm;
}

// Spread right-ish hand, palm to camera, fingers up. Units: wrist at the origin, wrist ->
// middle MCP = 1, x right, y down (source space, before the mirror).
const SPREAD_HAND = [
  [0, 0],
  [-0.35, -0.2], [-0.65, -0.45], [-0.9, -0.7], [-1.1, -0.9],
  [-0.35, -0.95], [-0.5, -1.4], [-0.6, -1.7], [-0.7, -1.95],
  [0, -1], [0, -1.5], [0, -1.85], [0, -2.1],
  [0.3, -0.92], [0.45, -1.35], [0.55, -1.65], [0.62, -1.9],
  [0.55, -0.8], [0.8, -1.1], [0.95, -1.3], [1.05, -1.5],
];
// Source-space wrist position and hand size (fraction of frame height). Sits to the side of
// the swaying head and above the body ellipse, so only the hand matte can cover it.
const SILHOUETTE = { x: 0.88, y: 0.42, size: 0.13 };

/** Synthetic 21-point spread hand in normalized source coordinates. */
export function spreadHandLandmarks({ x, y, size } = SILHOUETTE) {
  const sx = size * (VIDEO_H / VIDEO_W);
  return SPREAD_HAND.map(([u, v]) => ({ x: x + u * sx, y: y + v * size }));
}

// Where the pinch hand sits in source space. Its thumb and index tips are set `ratio` apart, in units
// of the wrist to middle-MCP distance (1), which is the same hand scale the detector divides by.
const PINCH_HAND = { x: 0.5, y: 0.45, size: 0.13 };

/** SYNTHETIC 21-point hand whose thumb and index tips are `ratio` hand scales apart, centred at x. */
export function pinchHandLandmarks(ratio, { x, y, size } = PINCH_HAND) {
  const lm = spreadHandLandmarks({ x, y, size });
  const at = (u, v) => {
    const sx = size * (VIDEO_H / VIDEO_W);
    return { x: x + u * sx, y: y + v * size };
  };
  lm[4] = at(-0.5 - ratio / 2, -1.0);
  lm[8] = at(-0.5 + ratio / 2, -1.0);
  return lm;
}

/**
 * `onSelect(mode)` is the QA select's hook (main.js passes the same selection a click uses). It sets
 * the mode directly for visual checks; it does not go through the pinch path.
 */
export function createTestMode(root, { onSelect } = {}) {
  const panel = document.createElement('section');
  panel.className = 'test-panel';
  // Radio group: one scripted hand at a time. Pinch scripts drive the real detector and mode path.
  const choices = [
    { id: 'none', label: 'No hand' },
    { id: 'open', label: 'SYNTHETIC hand - open' },
    { id: 'single', label: 'SYNTHETIC single pinch' },
    { id: 'double', label: 'SYNTHETIC double pinch (should cancel)' },
    { id: 'near', label: 'SYNTHETIC near but not pinched' },
    { id: 'slow', label: 'SYNTHETIC slow pinch' },
    { id: 'silhouette', label: 'SYNTHETIC hand (visible + mask, no pinch)' },
  ];
  panel.innerHTML = `
    <strong>Test mode - SYNTHETIC frame/mask</strong>
    <div class="test-buttons">
      ${choices.map((c) => `<button type="button" data-zone="${c.id}" aria-pressed="${c.id === 'none'}">${c.label}</button>`).join('\n      ')}
    </div>
    <label class="test-select">QA pick effect (bypasses pinch)
      <select data-qa-select>
        ${TARGETS.map((t) => `<option value="${t.mode}">${t.id} ${t.label}</option>`).join('')}
      </select>
    </label>
    <pre class="test-diag"></pre>`;
  root.appendChild(panel);
  const diag = panel.querySelector('.test-diag');

  let held = 'none';
  // Script start time, set on the first tick after a choice. Null while no script runs.
  let scriptStart = null;
  const buttons = [...panel.querySelectorAll('button[data-zone]')];
  const sync = () => {
    for (const btn of buttons) btn.setAttribute('aria-pressed', String(btn.dataset.zone === held));
  };
  for (const btn of buttons) {
    btn.addEventListener('click', () => {
      held = btn.dataset.zone;
      scriptStart = null;
      sync();
    });
  }
  panel.querySelector('[data-qa-select]').addEventListener('change', (e) => onSelect?.(e.target.value));

  const canvas = document.createElement('canvas');
  canvas.width = VIDEO_W;
  canvas.height = VIDEO_H;
  const ctx = canvas.getContext('2d', { alpha: false });
  const mask = new Float32Array(MASK_W * MASK_H);
  let lastMaskAt = -Infinity;
  let handSeq = 0;
  let lastHandAt = -Infinity;
  // Script state when the synthetic hand sample was taken: a distance ratio, or null for no hand.
  let latestHand = null;
  let lastDropoutAt = -Infinity;
  let lastPoseAt = -Infinity;
  let latestPose = null;
  let stream = null;

  const drawFrame = (now) => {
    drawPattern(ctx, now);
    if (held === 'silhouette') drawHand(ctx, spreadHandLandmarks());
  };

  return {
    startStream() {
      drawFrame(performance.now());
      stream = canvas.captureStream(30);
      return stream;
    },
    stopStream() {
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      latestPose = null;
    },
    tick(now, setMask) {
      drawFrame(now);
      if (now - lastMaskAt >= MASK_INTERVAL_MS) {
        lastMaskAt = now;
        let dropout = null;
        if (now - lastDropoutAt >= DROPOUT_PERIOD_MS) {
          lastDropoutAt = now;
          // Fixed spot inside the body, offset from its centre, in mask pixels.
          const { body } = personShapes(now);
          dropout = { x: (body.x + 0.06) * MASK_W, y: 0.62 * MASK_H };
        }
        writeMask(mask, now, dropout);
        setMask(mask, MASK_W, MASK_H, now);
      }
      if (now - lastPoseAt >= POSE_INTERVAL_MS) {
        lastPoseAt = now;
        latestPose = { sampledAt: now, frameTime: now / 1000, poses: syntheticPose(now) };
      }
      if (now - lastHandAt >= HAND_INTERVAL_MS) {
        lastHandAt = now;
        if (scriptStart === null) scriptStart = now;
        const keys = PINCH_SCRIPTS[held];
        latestHand = { seq: ++handSeq, sampledAt: now, ratio: keys ? pinchRatioAt(keys, now - scriptStart) : null };
      }
    },
    /** SYNTHETIC pose sample for the processed coverage (effects 1, 3, 4, 6), or null. */
    poseSample: () => latestPose,
    /**
     * Latest synthetic hand sample as { seq, sampledAt, hands }, built from the active script. Its
     * landmarks come from the pinch geometry in source space, like real landmarks.
     */
    handSample() {
      if (!latestHand) return null;
      const hands = latestHand.ratio === null ? [] : [pinchHandLandmarks(latestHand.ratio)];
      return { seq: latestHand.seq, sampledAt: latestHand.sampledAt, hands };
    },
    /** The visible spread hand, for the matte only; it never pinches. */
    silhouetteHands() {
      return held === 'silhouette' ? [spreadHandLandmarks()] : [];
    },
    showDiagnostics(d) {
      const p = d.pinch;
      const ms = (v) => (Number.isFinite(v) ? `${v.toFixed(0)} ms` : '—');
      const num = (v, n) => (Number.isFinite(v) ? v.toFixed(n) : '—');
      const windowLeft = d.modes.pendingAt === null
        ? '—'
        : ms(Math.max(0, DOUBLE_WINDOW_MS - (d.now - d.modes.pendingAt)));
      diag.textContent = [
        'SYNTHETIC',
        `script    ${held}`,
        `mode      ${d.mode}`,
        `sample    seq ${latestHand?.seq ?? '-'}  age ${ms(d.sampleAgeMs)}`,
        `ratio     ${num(p.ratio, 3)}  predicted ${num(p.predicted, 3)}  velocity ${num(p.velocity, 2)}/s`,
        `pinch     ${p.state}  cooldown ${ms(p.cooldownMs)}  double window left ${windowLeft}`,
        `last      ${d.lastPinch ? `${d.lastPinch.action} ${ms(d.now - d.lastPinch.at)} ago` : '—'}`,
        `matte     ${held === 'silhouette' ? 'synthetic hand' : '-'}`,
        `fps       ${d.fps.toFixed(0)}`,
        `float     ${d.fluidType ?? 'unsupported'}`,
      ].join('\n');
    },
  };
}
