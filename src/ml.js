import { FilesetResolver, HandLandmarker, ImageSegmenter, PoseLandmarker } from '@mediapipe/tasks-vision';
import { handSampleAgeMs } from './hand-sample.js';
import { POSE_BASE_STRIDE, POSE_PROBE_FRAMES, poseStrideFor } from './pose-capsules.js';

const MODELS = {
  segmenter: {
    file: 'selfie_segmenter.tflite',
    remote: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite',
  },
  hands: {
    file: 'hand_landmarker.task',
    remote: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task',
  },
  pose: {
    file: 'pose_landmarker_lite.task',
    remote: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task',
  },
};

const INFER_SHORT_SIDE = 256;

// Strictly increasing across every pipeline on the page, so a hand sample's seq is never reused
// after a Stop/Start (the gesture logic ignores any seq it has already applied).
let handSeq = 0;

const assetUrl = (path) => new URL(`${import.meta.env.BASE_URL}${path}`, document.baseURI).href;

async function resolveModel({ file, remote }) {
  const local = assetUrl(`models/${file}`);
  try {
    const res = await fetch(local, { method: 'HEAD' });
    // SPA-style servers answer missing files with index.html and a 200.
    if (res.ok && !(res.headers.get('content-type') || '').includes('text/html')) return local;
  } catch {
    // fall through to the remote model
  }
  return remote;
}

async function withDelegate(create) {
  try {
    return await create('GPU');
  } catch (err) {
    console.warn('GPU delegate failed, using CPU', err);
    return create('CPU');
  }
}

/**
 * Loads the tasks and returns a tick-driven, non-overlapping inference loop.
 * Scheduler: tick() runs once per render frame. When a call is due it queues exactly one setTimeout(0)
 * task that runs one GPU call (segmentation, hands or pose). Nothing else is queued until that task
 * has finished, so there is never a parallel call and no backlog.
 *
 * Order within a video frame (see the comments in tick()):
 * 1. hands and segmentation alternate as before, and each video frame gets one of each;
 * 2. pose is owed once every `poseStride` video frames (3 by default, adaptive, see pose-capsules.js),
 *    and it runs after that frame's hands and segmentation, before the next frame's calls.
 * Pose can therefore delay the next hand call by one pose call per stride. The stride bounds how often.
 * If the pose model is unavailable or fails, the loop carries on with hands and segmentation only.
 */
export async function createML({ onMask, onError }) {
  const fileset = await FilesetResolver.forVisionTasks(assetUrl('mediapipe/wasm'));
  const [segmenterPath, handsPath, posePath] = await Promise.all([
    resolveModel(MODELS.segmenter),
    resolveModel(MODELS.hands),
    resolveModel(MODELS.pose),
  ]);

  // Sequential on purpose: tasks share a global module factory while they initialize.
  const segmenter = await withDelegate((delegate) =>
    ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: segmenterPath, delegate },
      runningMode: 'VIDEO',
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    }),
  );
  let handLandmarker;
  try {
    handLandmarker = await withDelegate((delegate) =>
      HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: handsPath, delegate },
        runningMode: 'VIDEO',
        numHands: 2,
      }),
    );
  } catch (err) {
    segmenter.close();
    throw err;
  }
  // Optional: a missing or failing pose model must not stop segmentation or hands.
  let poseLandmarker = null;
  try {
    poseLandmarker = await withDelegate((delegate) =>
      PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: posePath, delegate },
        runningMode: 'VIDEO',
        numPoses: 1,
      }),
    );
  } catch (err) {
    console.warn('Pose model unavailable; continuing without pose', err);
  }

  // Selfie model: the person is the labelled class, otherwise the last mask.
  const personLabel = segmenter.getLabels().findIndex((label) => /person|selfie/i.test(label));

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { alpha: false });

  let busy = false;
  let closed = false;
  let failed = false;
  // Bumped by invalidate(). A task queued under an older input is dropped without running.
  let inputEpoch = 0;
  let lastTimestamp = 0;
  // Hands go first on start, so the first hand sample doesn't wait behind a segmentation call.
  let segmentNext = false;
  let lastSegmentTime = -1;
  let lastHandsTime = -1;
  let lastPoseTime = -1;
  // { seq, sampledAt, frameTime, hands }. sampledAt is stamped inside the task (see hand-sample.js).
  let latestHand = null;
  // { sampledAt, frameTime, poses }: poses is 33 landmarks of one person, or null. Gated in pose-capsules.js.
  let latestPose = null;
  // Pose scheduling state. poseWanted is a single owed call (never a queue); poseFrame is the video time
  // it was owed at. frameCount counts new video frames seen by tick().
  let poseAvailable = poseLandmarker !== null;
  let poseWanted = false;
  let poseFrame = -1;
  let frameCount = 0;
  let lastFrameSeen = -1;
  let poseStride = POSE_BASE_STRIDE;
  let poseFramesSinceProbe = 0;
  let poseMsEma = null;
  // Duration of the last inference call of each kind (diagnostics only; not end-to-end latency).
  let segmentMs = null;
  let handsMs = null;
  let poseMs = null;

  const nextTimestamp = () => (lastTimestamp = Math.max(Math.floor(performance.now()), lastTimestamp + 1));

  function drawFrame(video) {
    const scale = INFER_SHORT_SIDE / Math.min(video.videoWidth, video.videoHeight);
    const w = Math.round(video.videoWidth * scale);
    const h = Math.round(video.videoHeight * scale);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.drawImage(video, 0, 0, w, h);
  }

  function runSegmenter(sampledAt) {
    const t0 = performance.now();
    const result = segmenter.segmentForVideo(canvas, nextTimestamp());
    segmentMs = performance.now() - t0;
    try {
      const masks = result.confidenceMasks;
      if (masks?.length) {
        const mask = masks[personLabel >= 0 && personLabel < masks.length ? personLabel : masks.length - 1];
        // The result's own timestamp: persistence and pose freshness are judged against it.
        onMask(mask.getAsFloat32Array(), mask.width, mask.height, sampledAt);
      }
    } finally {
      result.close();
    }
  }

  function runHands(sampledAt, frameTime) {
    const t0 = performance.now();
    const hands = handLandmarker.detectForVideo(canvas, nextTimestamp()).landmarks ?? [];
    handsMs = performance.now() - t0;
    latestHand = { seq: ++handSeq, sampledAt, frameTime, hands };
  }

  function runPose(sampledAt, frameTime) {
    const t0 = performance.now();
    const landmarks = poseLandmarker.detectForVideo(canvas, nextTimestamp()).landmarks ?? [];
    poseMs = performance.now() - t0;
    latestPose = { sampledAt, frameTime, poses: landmarks[0] ?? null };
    poseMsEma = poseMsEma === null ? poseMs : poseMsEma + (poseMs - poseMsEma) * 0.3;
    poseStride = poseStrideFor(poseMsEma, (segmentMs ?? 0) + (handsMs ?? 0));
  }

  // Once per new video frame: counts the frame and owes a pose call on every poseStride-th frame.
  // With the stride at 0 (skipped) it owes one probe call every POSE_PROBE_FRAMES frames.
  function countFrame(time) {
    if (time === lastFrameSeen) return;
    lastFrameSeen = time;
    frameCount++;
    if (!poseAvailable || poseWanted) return;
    poseFramesSinceProbe++;
    const due = poseStride > 0 ? frameCount % poseStride === 0 : poseFramesSinceProbe >= POSE_PROBE_FRAMES;
    if (due) {
      poseWanted = true;
      poseFrame = time;
      poseFramesSinceProbe = 0;
    }
  }

  /**
   * Call once per frame. Queues at most one task, and only when the video has a frame this kind has
   * not handled yet (the currentTime guard). The task re-checks the input when it runs.
   */
  function tick(video) {
    if (closed || failed || video.readyState < 2 || !video.videoWidth) return;
    const time = video.currentTime;
    countFrame(time);
    if (busy) return;
    const segmentDue = time !== lastSegmentTime;
    const handsDue = time !== lastHandsTime;
    // Pose only after both calls of the frame it was owed at have run (>=, so a skipped frame still counts).
    const poseReady = poseWanted && lastSegmentTime >= poseFrame && lastHandsTime >= poseFrame;
    let kind;
    if (poseReady) kind = 'pose';
    else if (!segmentDue && !handsDue) return;
    else kind = segmentDue && (segmentNext || !handsDue) ? 'segment' : 'hands';
    const epoch = inputEpoch;

    busy = true;
    setTimeout(() => {
      busy = false;
      // Input was invalidated or the pipeline closed after this task was queued: nothing to do.
      if (closed || epoch !== inputEpoch || video.readyState < 2 || !video.videoWidth) return;
      const frameTime = video.currentTime;
      const lastOfKind = kind === 'segment' ? lastSegmentTime : kind === 'hands' ? lastHandsTime : lastPoseTime;
      if (frameTime === lastOfKind) return;
      // Stamped when the inference is invoked, not when the task was queued.
      const sampledAt = performance.now();
      try {
        drawFrame(video);
        if (kind === 'segment') {
          lastSegmentTime = frameTime;
          runSegmenter(sampledAt);
          segmentNext = false;
        } else if (kind === 'hands') {
          lastHandsTime = frameTime;
          runHands(sampledAt, frameTime);
          segmentNext = true;
        } else {
          lastPoseTime = frameTime;
          poseWanted = false;
          runPose(sampledAt, frameTime);
        }
      } catch (err) {
        if (kind === 'pose') {
          // Pose is optional: drop it for this session and keep hands and segmentation running.
          console.warn('Pose inference failed; continuing without pose', err);
          poseAvailable = false;
          poseWanted = false;
          latestPose = null;
          poseMs = null;
          return;
        }
        failed = true;
        onError(err);
      }
    }, 0);
  }

  return {
    tick,
    /** Latest completed hand sample, or null. Callers judge freshness (see hand-sample.js). */
    handSample: () => latestHand,
    /** Latest completed pose sample, or null. Callers judge freshness against the mask time. */
    poseSample: () => latestPose,
    /** Drops cached hands and pose, and turns queued tasks for the old input into no-ops (camera switch, stop). */
    invalidate() {
      inputEpoch++;
      latestHand = null;
      latestPose = null;
      // A new stream restarts currentTime, so the duplicate guard must not block its first frame.
      lastSegmentTime = -1;
      lastHandsTime = -1;
      lastPoseTime = -1;
      poseWanted = false;
      poseFrame = -1;
      lastFrameSeen = -1;
    },
    stats: (now = performance.now()) => ({
      segmentMs,
      handsMs,
      handAgeMs: handSampleAgeMs(latestHand, now),
      poseMs,
      poseEma: poseMsEma,
      poseAgeMs: latestPose ? now - latestPose.sampledAt : Infinity,
      poseStride: poseAvailable ? poseStride : null,
    }),
    close() {
      closed = true;
      segmenter.close();
      handLandmarker.close();
      poseLandmarker?.close();
    },
  };
}
