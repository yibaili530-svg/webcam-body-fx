// Pose scheduling contract for src/ml.js. MediaPipe is replaced by fakes; each fake records its call in
// `log`, and the pose fake can advance the fake clock to model a slow or fast pose call.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => ({
  segmenter: null,
  handLandmarker: null,
  poseLandmarker: null,
  createPose: null,
  onPose: null,
}));

vi.mock('@mediapipe/tasks-vision', () => ({
  FilesetResolver: { forVisionTasks: async () => ({}) },
  ImageSegmenter: { createFromOptions: async () => fakes.segmenter },
  HandLandmarker: { createFromOptions: async () => fakes.handLandmarker },
  PoseLandmarker: { createFromOptions: async () => fakes.createPose() },
}));

const { createML } = await import('../src/ml.js');

let clock;
let video;
let log;
let ml;
let onError;

const runDue = () => vi.runOnlyPendingTimers();

// One render-frame per video frame: tick, run the single queued task, repeat until nothing is due.
// Returns the largest number of pending tasks seen at any point (must stay at most 1).
function processFrame(time) {
  video.currentTime = time;
  let maxPending = 0;
  for (let k = 0; k < 6; k++) {
    ml.tick(video);
    maxPending = Math.max(maxPending, vi.getTimerCount());
    if (vi.getTimerCount() === 0) break;
    runDue();
  }
  return maxPending;
}

async function makeMl(extra = {}) {
  return createML({ onMask: () => {}, onError, ...extra });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  clock = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  globalThis.fetch = vi.fn(async () => {
    throw new TypeError('offline');
  });
  globalThis.document = {
    baseURI: 'http://localhost/',
    createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }) }),
  };
  log = [];
  onError = vi.fn();
  fakes.onPose = () => {};
  fakes.segmenter = {
    getLabels: () => ['background', 'person'],
    segmentForVideo: () => {
      log.push('segment');
      return { confidenceMasks: [{ width: 2, height: 2, getAsFloat32Array: () => new Float32Array(4) }], close() {} };
    },
    close() {},
  };
  fakes.handLandmarker = {
    detectForVideo: () => {
      log.push('hands');
      return { landmarks: [] };
    },
    close() {},
  };
  fakes.poseLandmarker = {
    detectForVideo: () => {
      log.push('pose');
      fakes.onPose();
      return { landmarks: [] };
    },
    close() {},
  };
  fakes.createPose = async () => fakes.poseLandmarker;
  video = { readyState: 4, videoWidth: 1280, videoHeight: 720, currentTime: 0 };
  ml = await makeMl();
});

afterEach(() => {
  ml?.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete globalThis.document;
  delete globalThis.fetch;
});

const count = (kind) => log.filter((k) => k === kind).length;

describe('never concurrent, with pose in the mix', () => {
  it('never has more than one pending task at any tick', () => {
    let max = 0;
    for (let i = 1; i <= 30; i++) max = Math.max(max, processFrame(i / 30));
    expect(max).toBe(1);
  });
});

describe('pose share', () => {
  it('runs pose about once every POSE_BASE_STRIDE frames while segmentation and hands run every frame', () => {
    for (let i = 1; i <= 30; i++) processFrame(i / 30);
    expect(count('segment')).toBe(30);
    expect(count('hands')).toBe(30);
    // Stride 3 with a cheap pose call: owed on frames 3, 6, ..., 30.
    expect(count('pose')).toBe(10);
  });

  it('hand calls are never starved by pose: one hand call per frame', () => {
    for (let i = 1; i <= 12; i++) processFrame(i / 30);
    expect(count('hands')).toBe(12);
  });

  it('runs pose only after that frame has had its hands and segmentation calls', () => {
    for (let i = 1; i <= 3; i++) processFrame(i / 30);
    // Frames 1 and 2: one hands and one segment each. Frame 3: the same two, then the owed pose.
    expect(log).toHaveLength(7);
    expect(log.slice(0, 6).filter((k) => k === 'hands')).toHaveLength(3);
    expect(log.slice(0, 6).filter((k) => k === 'segment')).toHaveLength(3);
    expect(log[6]).toBe('pose');
  });
});

describe('adaptive skip', () => {
  it('skips pose after a slow call and reports the skip in the stats', () => {
    fakes.onPose = () => {
      clock += 40; // 40 ms per pose call, above the 30 ms band: stride 0
    };
    for (let i = 1; i <= 30; i++) processFrame(i / 30);
    expect(count('pose')).toBeLessThanOrEqual(2);
    expect(ml.stats(clock).poseStride).toBe(0);
    expect(ml.stats(clock).poseMs).toBe(40);
  });

  it('keeps the base stride while the pose call is cheap', () => {
    for (let i = 1; i <= 6; i++) processFrame(i / 30);
    expect(ml.stats(clock).poseStride).toBe(3);
  });
});

describe('graceful pose failure', () => {
  it('carries on with hands and segmentation when the pose model cannot be created', async () => {
    fakes.createPose = async () => {
      throw new Error('model missing');
    };
    ml.close();
    ml = await makeMl();
    for (let i = 1; i <= 6; i++) processFrame(i / 30);
    expect(count('pose')).toBe(0);
    expect(count('hands')).toBe(6);
    expect(count('segment')).toBe(6);
    expect(onError).not.toHaveBeenCalled();
    expect(ml.stats(clock).poseStride).toBeNull();
  });

  it('drops pose after a failed pose call, without failing hands or segmentation', () => {
    let calls = 0;
    fakes.poseLandmarker.detectForVideo = () => {
      log.push('pose');
      calls++;
      throw new Error('pose gpu lost');
    };
    for (let i = 1; i <= 12; i++) processFrame(i / 30);
    expect(calls).toBe(1);
    expect(count('hands')).toBe(12);
    expect(count('segment')).toBe(12);
    expect(onError).not.toHaveBeenCalled();
    expect(ml.stats(clock).poseStride).toBeNull();
    expect(ml.poseSample()).toBeNull();
  });
});

describe('invalidation and pose', () => {
  it('drops a pose call queued before invalidate(): it never runs for the old input', () => {
    // Frames 1 and 2 pass fully; frame 3 is owed pose and its hands and segmentation go first.
    processFrame(1 / 30);
    processFrame(2 / 30);
    video.currentTime = 3 / 30;
    ml.tick(video);
    runDue(); // hands or segmentation
    ml.tick(video);
    runDue(); // the other one
    ml.tick(video);
    expect(vi.getTimerCount()).toBe(1); // pose is now queued
    const posesBefore = count('pose');
    ml.invalidate();
    runDue();
    expect(count('pose')).toBe(posesBefore);
    expect(ml.poseSample()).toBeNull();
  });
});
