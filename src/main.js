import './style.css';
import { TARGET_RADIUS, TARGETS } from './gesture.js';
import { coverCrop } from './mapping.js';
import { createView } from './view.js';
import { createCameraController } from './camera.js';
import { freshHandSample, handSampleAgeMs } from './hand-sample.js';
import { createHandPredictor, translateHand } from './hand-predict.js';
import { createPinchDetector } from './pinch.js';
import { createModeController, DOUBLE_WINDOW_MS } from './modes.js';
import { installInfoToggle } from './info-toggle.js';

const isTest = new URLSearchParams(location.search).get('test') === '1';
// Opt-in ?diag=1 overlay: display rate, inference call durations, hand sample age and mask age.
const isDiag = new URLSearchParams(location.search).get('diag') === '1';

const stage = document.querySelector('#stage');
const viewHost = document.querySelector('#view');
const video = document.querySelector('#video');
const startBtn = document.querySelector('#start');
const resetBtn = document.querySelector('#reset');
const statusEl = document.querySelector('#status');
const targetsHost = document.querySelector('#targets');
// H key or ⓘ button hides the bottom bar. It only hides while the camera runs (see info-toggle.js).
installInfoToggle({ stage, button: document.querySelector('#info-toggle') });

// Pinch (thumb and index, either hand) drives the effect: pinch.js detects it, modes.js decides.
const pinch = createPinchDetector();
const modes = createModeController();
let session = null;
let testMode = null;
let lastPinch = null;

// Manual fallback: a click, tap or keyboard activation selects the effect directly, as before.
function selectMode(mode) {
  if (modes.select(mode)) renderTargets();
}

const targetEls = Object.fromEntries(TARGETS.map((t) => {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'target';
  el.style.left = `${t.x * 100}%`;
  el.style.top = `${t.y * 100}%`;
  el.dataset.enabled = String(t.enabled);
  el.setAttribute('aria-label', t.enabled ? `${t.label} (also clickable)` : `${t.label} (unavailable)`);
  if (!t.enabled) el.setAttribute('aria-disabled', 'true');
  el.innerHTML = `<span class="label">${t.label}</span>`;
  el.addEventListener('click', () => selectMode(t.mode));
  targetsHost.appendChild(el);
  return [t.id, el];
}));

function sizeTargets(w, h) {
  targetsHost.style.setProperty('--r', `${TARGET_RADIUS * Math.min(w, h)}px`);
}
sizeTargets(innerWidth, innerHeight);

function setStatus(text, kind = 'info') {
  statusEl.textContent = text;
  statusEl.dataset.kind = kind;
}

function cameraErrorText(kind, err) {
  switch (kind) {
    case 'denied': return 'Camera permission denied. Allow it in browser settings and try again';
    case 'missing': return 'No camera found. Check the connection and try again';
    case 'overconstrained': return 'Camera does not support the required resolution';
    case 'busy': return 'Camera is in use or cannot be read. Close other apps and try again';
    default: return `Camera error: ${err?.message ?? err}`;
  }
}

const camera = createCameraController({
  mediaDevices: navigator.mediaDevices,
  video,
  onLost: () => {
    if (session) stop('Camera disconnected. Reconnect and click Start', 'error');
  },
});

function renderTargets() {
  const current = modes.mode();
  for (const [id, el] of Object.entries(targetEls)) {
    el.dataset.current = String(TARGETS.find((t) => t.id === id).mode === current);
  }
}

function readyStatus(s) {
  if (!s.view.fluidType) setStatus('Device does not support float render targets; fluid unavailable — camera preview only', 'error');
  else if (s.mlFailed) setStatus('Model load or inference failed — camera preview only', 'error');
  else setStatus(isTest ? 'Ready (synthetic)' : 'Ready', 'ok');
}

const diagEl = isDiag ? Object.assign(document.createElement('pre'), { className: 'diag' }) : null;
if (diagEl) stage.appendChild(diagEl);

const fmtMs = (v) => (Number.isFinite(v) ? `${v.toFixed(1)} ms` : '—');

// Inference durations are the time one call blocked the main thread, not end-to-end latency.
// The hand sample age counts from the moment the hand inference was invoked.
function updateDiag(s, now) {
  const delta = now - s.diagFrameAt;
  s.diagFrameAt = now;
  if (delta > 0) s.diagFps += (1000 / delta - s.diagFps) * 0.05;
  if (now - s.diagShownAt < 250) return;
  s.diagShownAt = now;
  const stats = s.ml?.stats(now);
  const mask = s.view?.maskStats();
  const pred = s.prediction;
  const stride = stats?.poseStride;
  diagEl.textContent = [
    `Display ${s.diagFps.toFixed(0)} fps`,
    `Segment ${fmtMs(stats?.segmentMs)}  Hands ${fmtMs(stats?.handsMs)}`,
    `Hand sample age ${fmtMs(stats?.handAgeMs)} (over 300 ms treated as no hand; not end-to-end latency)`,
    `Mask age ${fmtMs(s.view?.maskAge(now))} (since last mask upload; not end-to-end latency)`,
    `Pose ${fmtMs(stats?.poseMs)}  Pose age ${fmtMs(stats?.poseAgeMs)}  Stride ${stride == null ? 'n/a' : stride === 0 ? 'skip' : `every ${stride} frames`}`,
    `Mask hold ${mask?.heldPx ?? 0} px (within 150 ms, enclosed gaps only)  Pose capsules ${mask?.poseCapsulePx ?? 0} px`,
    `Hand predict horizon ${fmtMs(pred?.horizonMs)}  lead ${pred ? pred.leadPx.toFixed(1) : '—'} px  gain ${pred ? pred.gain.toFixed(2) : '—'} (display only, not used for gestures)`,
    pinchLine(s, now),
  ].join('\n');
}

// Pinch diagnostics: distance ratio (thumb to index over hand scale), predicted ratio, approach speed,
// per-hand state, the last effect change, and the double-pinch window and refractory time left.
function pinchLine(s, now) {
  const p = pinch.snapshot();
  const m = modes.snapshot();
  const num = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : '—');
  const windowLeft = m.pendingAt === null ? 'none' : `${Math.max(0, DOUBLE_WINDOW_MS - (now - m.pendingAt)).toFixed(0)} ms`;
  const last = lastPinch ? `${lastPinch.action === 'cancel' ? 'cancel' : 'next'} ${(now - lastPinch.at).toFixed(0)} ms ago` : 'none';
  return [
    `Pinch ratio ${num(p.ratio, 3)}  predicted ${num(p.predicted, 3)}  vel ${num(p.velocity, 2)}/s  state ${p.state}`,
    `Last ${last}  double window left ${windowLeft}  refractory left ${pinch.cooldownMs(now).toFixed(0)} ms`,
  ].join('\n');
}

function frame(s, now) {
  if (s.stopped) return;
  s.raf = requestAnimationFrame((t) => frame(s, t));

  const rect = s.size;
  const crop = coverCrop(video.videoWidth, video.videoHeight, rect.w, rect.h);

  // The latest sample is re-read every frame. Only a fresh one is a candidate, and the pinch detector
  // applies a candidate once, by its seq. A cached sample is never a new observation.
  let raw = null;
  if (testMode) {
    testMode.tick(now, s.view.setMask);
    raw = testMode.handSample(crop);
  } else if (s.ml) {
    s.ml.tick(video);
    raw = s.ml.handSample();
  }
  const hands = freshHandSample(raw, now);
  const landmarks = hands?.hands ?? [];
  // Pinch reads only fresh samples, each once (by seq). Landmarks are source-space, so the frame size
  // makes the distance isotropic.
  const pinchSample = hands;
  const pinchResult = pinch.observe(pinchSample, { w: video.videoWidth, h: video.videoHeight }, now);
  if (pinchResult.event) {
    const change = modes.pinch(now);
    lastPinch = { action: change.action, at: now };
    renderTargets();
  }
  const state = { mode: modes.mode() };

  // Display only: the matte leads the observed hands by a short, damped prediction (hand-predict.js).
  // The pinch above read the real fresh samples only; the predicted landmarks never reach it or storage.
  let matteHands = landmarks;
  if (hands && video.videoWidth && video.videoHeight) {
    s.predictor.observe(hands, { w: video.videoWidth, h: video.videoHeight });
    const predicted = s.predictor.predict(now);
    s.prediction = predicted;
    matteHands = landmarks.map((hand, i) => translateHand(hand, predicted.offsets[i]?.dx ?? 0, predicted.offsets[i]?.dy ?? 0));
  }
  // Pose is only read by the processed coverage (effects 1, 3, 4, 6). It is cheap to pass every frame.
  s.view.setPose(testMode ? testMode.poseSample() : s.ml?.poseSample() ?? null);
  // The test silhouette hand only feeds the matte, so it can't trigger a target.
  s.view.setHands(testMode ? [...matteHands, ...testMode.silhouetteHands()] : matteHands);
  if (video.videoWidth) s.view.render(now, state, crop);
  if (diagEl) updateDiag(s, now);

  if (testMode) {
    const delta = now - s.lastFrameAt;
    s.lastFrameAt = now;
    if (delta > 0) s.fps += (1000 / delta - s.fps) * 0.05;
    testMode.showDiagnostics({
      mode: state.mode,
      pinch: { ...pinch.snapshot(), cooldownMs: pinch.cooldownMs(now) },
      modes: modes.snapshot(),
      lastPinch,
      now,
      sampleAgeMs: handSampleAgeMs(raw, now),
      fps: s.fps,
      fluidType: s.view.fluidType,
    });
  }
}

async function loadML(s) {
  setStatus('Loading models…');
  try {
    const { createML } = await import('./ml.js');
    const ml = await createML({
      onMask: s.view.setMask,
      onError: (err) => {
        console.error(err);
        s.mlFailed = true;
        readyStatus(s);
      },
    });
    if (s.stopped) {
      ml.close();
      return;
    }
    s.ml = ml;
  } catch (err) {
    console.error(err);
    if (s.stopped) return;
    s.mlFailed = true;
  }
  readyStatus(s);
}

function setRunning(running) {
  startBtn.textContent = running ? 'Stop' : 'Start';
  stage.classList.toggle('running', running);
}

// Builds the view and frame loop once, on the first live feed.
function attachView(s) {
  if (s.view || s.raf) return;
  try {
    s.view = createView({
      host: viewHost,
      video,
      onContextLost: () => setStatus('WebGL context lost, waiting to restore…', 'error'),
      onContextRestored: () => readyStatus(s),
      onError: () => setStatus('Shader compile failed', 'error'),
    });
  } catch (err) {
    // Plain mirrored <video> so the preview still works.
    console.error(err);
    stage.classList.add('no-webgl');
    setStatus('WebGL2 unavailable — camera preview only', 'error');
    return;
  }

  s.observer = new ResizeObserver(([entry]) => {
    s.size = { w: entry.contentRect.width, h: entry.contentRect.height };
    s.view.resize(s.size.w, s.size.h);
    sizeTargets(s.size.w, s.size.h);
  });
  s.observer.observe(viewHost);
  s.raf = requestAnimationFrame((t) => frame(s, t));

  if (testMode) readyStatus(s);
  else loadML(s);
}

// Applies the result of a camera request to the session it belongs to. Stale results are dropped:
// a Stop has already taken over the element.
async function connect(s, pending) {
  const result = await pending;
  if (s.stopped || session !== s || result.stale) return;
  if (!result.ok) {
    console.error(result.error ?? result.kind);
    stop(cameraErrorText(result.kind, result.error), 'error');
    return;
  }
  attachView(s);
}

async function start() {
  const s = {
    stopped: false, view: null, ml: null, mlFailed: false, raf: 0, size: { w: 0, h: 0 },
    fps: 60, lastFrameAt: 0, diagFps: 60, diagFrameAt: performance.now(), diagShownAt: -Infinity,
    predictor: createHandPredictor(), prediction: null,
  };
  session = s;
  setRunning(true);

  if (testMode) {
    try {
      const stream = testMode.startStream();
      video.srcObject = stream;
      await video.play();
    } catch (err) {
      console.error(err);
      stop(cameraErrorText('other', err), 'error');
      return;
    }
    if (s.stopped) return;
    attachView(s);
    return;
  }

  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    stop('Camera requires HTTPS or localhost', 'error');
    return;
  }
  setStatus('Requesting camera…');
  await connect(s, camera.start());
}

function stop(message = 'Stopped', kind = 'info') {
  const s = session;
  session = null;
  if (s) {
    s.stopped = true;
    s.predictor.reset();
    cancelAnimationFrame(s.raf);
    s.observer?.disconnect();
    s.ml?.close();
    s.view?.dispose();
  }
  testMode?.stopStream();
  camera.stop();
  video.srcObject = null;
  stage.classList.remove('no-webgl');
  // Camera is off, so no hand observation may carry over into the next Start.
  modes.reset();
  pinch.reset();
  lastPinch = null;
  renderTargets();
  setRunning(false);
  setStatus(message, kind);
}

startBtn.addEventListener('click', () => (session ? stop() : start()));
resetBtn.addEventListener('click', () => {
  modes.reset();
  renderTargets();
});
window.addEventListener('pagehide', () => session && stop());

if (isTest) {
  const { createTestMode } = await import('./testmode.js');
  testMode = createTestMode(stage, { onSelect: (mode) => selectMode(mode) });
  setStatus('Test mode: click Start');
} else if (!window.isSecureContext || !navigator.mediaDevices) {
  setStatus('Camera requires HTTPS or localhost', 'error');
} else {
  setStatus('Click Start. Video stays on-device — no recording, no upload');
}
