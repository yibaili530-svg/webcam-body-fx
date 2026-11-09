// Scheduler contract for src/ml.js with MediaPipe replaced by fakes. Each fake records the call it
// receives, so the tests can see which GPU call ran in which task, and when.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => ({ segmenter: null, handLandmarker: null }));

vi.mock('@mediapipe/tasks-vision', () => ({
  FilesetResolver: { forVisionTasks: async () => ({}) },
  ImageSegmenter: { createFromOptions: async () => fakes.segmenter },
  HandLandmarker: { createFromOptions: async () => fakes.handLandmarker },
}));

const { createML } = await import('../src/ml.js');

let clock;
let video;
let log;
let ml;

const runDue = () => vi.runOnlyPendingTimers();

beforeEach(async () => {
  // Only the timer functions are faked. performance.now is driven by `clock` through a spy below.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  clock = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  globalThis.fetch = vi.fn(async () => {
    throw new TypeError('offline');
  });
  globalThis.document = {
    baseURI: 'http://localhost/',
    createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }) }),
  };
  log = [];
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
  video = { readyState: 4, videoWidth: 1280, videoHeight: 720, currentTime: 0 };
  ml = await createML({ onMask: () => {}, onError: () => {} });
});

afterEach(() => {
  ml?.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete globalThis.document;
  delete globalThis.fetch;
});

describe('one task at a time', () => {
  it('queues exactly one task per due frame and none while that task is pending', () => {
    video.currentTime = 0.1;
    ml.tick(video);
    ml.tick(video);
    ml.tick(video);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('runs exactly one inference call per task', () => {
    for (let i = 1; i <= 4; i++) {
      video.currentTime = i / 10;
      ml.tick(video);
      runDue();
      expect(log).toHaveLength(i);
    }
  });

  it('frames that arrive while busy are not queued up: the next task reads the newest frame', () => {
    video.currentTime = 0.1;
    ml.tick(video);
    video.currentTime = 0.2;
    ml.tick(video);
    video.currentTime = 0.3;
    ml.tick(video);
    expect(vi.getTimerCount()).toBe(1);
    runDue();
    expect(log).toEqual(['hands']);
    ml.tick(video);
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe('scheduling order', () => {
  it('starts with hands, so the first hand sample does not wait behind a segmentation call', () => {
    video.currentTime = 0.1;
    ml.tick(video);
    runDue();
    expect(log).toEqual(['hands']);
  });

  it('alternates segmentation and hands while both are due, so neither starves', () => {
    for (let i = 1; i <= 6; i++) {
      video.currentTime = i / 10;
      ml.tick(video);
      runDue();
    }
    expect(log).toEqual(['hands', 'segment', 'hands', 'segment', 'hands', 'segment']);
  });

  it('hands are never starved: over 20 frames with both due, every other task is a hand call', () => {
    for (let i = 1; i <= 20; i++) {
      video.currentTime = i / 10;
      ml.tick(video);
      runDue();
    }
    const hands = log.filter((kind) => kind === 'hands').length;
    expect(hands).toBe(10);
    expect(log.some((kind, i) => kind === 'segment' && log[i + 1] === 'segment')).toBe(false);
  });

  it('segmentation still runs for a frame that only the hands call has handled', () => {
    video.currentTime = 0.1;
    ml.tick(video);
    runDue(); // hands; segmentation is now the next one due
    ml.tick(video);
    runDue();
    expect(log).toEqual(['hands', 'segment']);
  });
});

describe('currentTime duplicate guard', () => {
  it('does not queue anything for a frame that has already been handled by both kinds', () => {
    video.currentTime = 0.1;
    ml.tick(video);
    runDue(); // hands at 0.1
    ml.tick(video);
    runDue(); // segment at 0.1
    ml.tick(video);
    expect(vi.getTimerCount()).toBe(0);
    expect(log).toEqual(['hands', 'segment']);
  });
});

describe('hand sample stamping', () => {
  it('stamps the sample when the call is invoked inside the task, not when the task was queued', () => {
    video.currentTime = 0.1;
    clock = 1000;
    ml.tick(video);
    clock = 1180;
    runDue();
    expect(ml.handSample()).toMatchObject({ sampledAt: 1180, frameTime: 0.1 });
  });

  it('records a seq for each completed hand call, and seq grows across invalidation', () => {
    video.currentTime = 0.1;
    ml.tick(video);
    runDue();
    const first = ml.handSample().seq;
    ml.invalidate();
    expect(ml.handSample()).toBeNull();
    video.currentTime = 0.2;
    ml.tick(video);
    runDue(); // segmentation
    video.currentTime = 0.3;
    ml.tick(video);
    runDue(); // hands
    expect(ml.handSample().seq).toBeGreaterThan(first);
  });

  it('exposes the age of the latest hand sample and the duration of each inference kind', () => {
    video.currentTime = 0.1;
    clock = 1000;
    ml.tick(video);
    clock = 1100;
    runDue();
    expect(ml.stats(1250)).toMatchObject({ handAgeMs: 150, handsMs: 0, segmentMs: null });
  });

  it('reports an infinite hand age before any hand sample exists', () => {
    expect(ml.stats(1000).handAgeMs).toBe(Infinity);
  });
});

describe('input validity', () => {
  it('invalidate drops a task queued for the old input: no inference and no sample', () => {
    video.currentTime = 0.1;
    ml.tick(video);
    ml.invalidate();
    runDue();
    expect(log).toEqual([]);
    expect(ml.handSample()).toBeNull();
  });

  it('after invalidate the pipeline resumes on the same frame time without a permanent lock', () => {
    video.currentTime = 0.1;
    ml.tick(video);
    runDue();
    ml.invalidate();
    ml.tick(video); // a new stream can report the same currentTime
    expect(vi.getTimerCount()).toBe(1);
    runDue();
    expect(log).toEqual(['hands', 'segment']);
  });

  it('does not infer while the video has no frame, and a task that finds the frame gone does nothing', () => {
    video.readyState = 1;
    ml.tick(video);
    expect(vi.getTimerCount()).toBe(0);

    video.readyState = 4;
    video.currentTime = 0.1;
    ml.tick(video);
    video.readyState = 0;
    runDue();
    expect(log).toEqual([]);
  });

  it('close() stops all further scheduling', () => {
    ml.close();
    video.currentTime = 0.1;
    ml.tick(video);
    expect(vi.getTimerCount()).toBe(0);
  });
});
