import { describe, expect, it } from 'vitest';
import { buildConstraints, classifyError, createCameraController } from '../src/camera.js';

// No browser APIs: getUserMedia and the video element are fakes. Each getUserMedia call takes its
// outcome from `script` (a function returning a promise), so a test can hold one request open and
// resolve it later.

const err = (name) => Object.assign(new Error(name), { name });
const flush = () => new Promise((r) => setTimeout(r, 0));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

function fakeStream() {
  const listeners = {};
  const track = {
    stopped: false,
    stop() { this.stopped = true; },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    fire(type) { (listeners[type] || []).forEach((fn) => fn()); },
  };
  return { track, getTracks: () => [track], getVideoTracks: () => [track] };
}

function fakeMediaDevices() {
  const script = [];
  const md = {
    calls: [],
    maxInFlight: 0,
    inFlight: 0,
    script(outcome) { script.push(outcome); },
    getUserMedia(constraints) {
      md.calls.push(constraints);
      md.inFlight++;
      md.maxInFlight = Math.max(md.maxInFlight, md.inFlight);
      const next = script.shift() ?? (() => Promise.resolve(fakeStream()));
      const settled = () => { md.inFlight--; };
      const p = Promise.resolve().then(() => next(constraints));
      p.then(settled, settled);
      return p;
    },
  };
  return md;
}

function setup({ mediaDevices } = {}) {
  const md = mediaDevices ?? fakeMediaDevices();
  const video = {
    srcObject: null,
    playCalls: 0,
    async play() { this.playCalls++; },
  };
  const lost = [];
  const camera = createCameraController({
    mediaDevices: md,
    video,
    onLost: (e) => lost.push(e),
  });
  return { camera, md, video, lost };
}

describe('constraints', () => {
  it('defaults to the front camera at 1280x720 with audio off', () => {
    expect(buildConstraints()).toEqual({
      video: { facingMode: 'user', width: 1280, height: 720 },
      audio: false,
    });
  });

  it('start requests the default constraints', async () => {
    const { camera, md } = setup();
    await camera.start();
    expect(md.calls[0]).toEqual(buildConstraints());
  });
});

describe('error classification', () => {
  it('maps browser error names to recovery kinds', () => {
    expect(classifyError(err('NotAllowedError'))).toBe('denied');
    expect(classifyError(err('SecurityError'))).toBe('denied');
    expect(classifyError(err('NotFoundError'))).toBe('missing');
    expect(classifyError(err('DevicesNotFoundError'))).toBe('missing');
    expect(classifyError(err('OverconstrainedError'))).toBe('overconstrained');
    expect(classifyError(err('NotReadableError'))).toBe('busy');
    expect(classifyError(err('TrackStartError'))).toBe('busy');
    expect(classifyError(err('SomethingElse'))).toBe('other');
    expect(classifyError(undefined)).toBe('other');
  });
});

describe('start', () => {
  it('a successful start attaches the stream and plays it once', async () => {
    const { camera, video } = setup();
    expect(await camera.start()).toEqual({ ok: true });
    expect(video.srcObject).not.toBeNull();
    expect(video.playCalls).toBe(1);
  });

  it('an overconstrained size retries once with only facingMode, then stops', async () => {
    const md = fakeMediaDevices();
    md.script(() => Promise.reject(err('OverconstrainedError')));
    md.script(() => Promise.reject(err('OverconstrainedError')));
    const { camera } = setup({ mediaDevices: md });
    const result = await camera.start();
    expect(md.calls).toHaveLength(2);
    expect(md.calls[1]).toEqual({ video: { facingMode: 'user' }, audio: false });
    expect(result).toMatchObject({ ok: false, kind: 'overconstrained' });
  });

  it('a denial is reported once and never retried', async () => {
    const md = fakeMediaDevices();
    md.script(() => Promise.reject(err('NotAllowedError')));
    const { camera, video } = setup({ mediaDevices: md });
    const result = await camera.start();
    expect(md.calls).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, kind: 'denied' });
    expect(video.srcObject).toBeNull();
  });

  it('a missing camera is reported once without retry', async () => {
    const md = fakeMediaDevices();
    md.script(() => Promise.reject(err('NotFoundError')));
    const { camera } = setup({ mediaDevices: md });
    const result = await camera.start();
    expect(md.calls).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, kind: 'missing' });
  });

  it('a busy camera is reported once without retry', async () => {
    const md = fakeMediaDevices();
    md.script(() => Promise.reject(err('NotReadableError')));
    const { camera } = setup({ mediaDevices: md });
    const result = await camera.start();
    expect(md.calls).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, kind: 'busy' });
  });

  it('an unrecognized error is reported as other, without retry', async () => {
    const md = fakeMediaDevices();
    md.script(() => Promise.reject(err('WeirdError')));
    const { camera } = setup({ mediaDevices: md });
    const result = await camera.start();
    expect(md.calls).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, kind: 'other' });
  });

  it('a play() failure stops the new tracks and reports other', async () => {
    const stream = fakeStream();
    const md = fakeMediaDevices();
    md.script(() => Promise.resolve(stream));
    const video = {
      srcObject: null,
      async play() { throw err('AbortError'); },
    };
    const camera = createCameraController({ mediaDevices: md, video });
    const result = await camera.start();
    expect(result).toMatchObject({ ok: false, kind: 'other' });
    expect(stream.track.stopped).toBe(true);
    expect(video.srcObject).toBeNull();
  });
});

describe('generation guard', () => {
  it('stop during a pending request stops the late stream and leaves the element alone', async () => {
    const md = fakeMediaDevices();
    const first = deferred();
    md.script(() => first.promise);
    const { camera, video } = setup({ mediaDevices: md });
    const pending = camera.start();
    await flush(); // in flight, so stop lands on a pending request
    camera.stop();
    const late = fakeStream();
    first.resolve(late);
    expect(await pending).toMatchObject({ stale: true });
    expect(late.track.stopped).toBe(true);
    expect(video.srcObject).toBeNull();
    expect(video.playCalls).toBe(0);
  });

  it('a second start waits for the first to settle, so getUserMedia never overlaps', async () => {
    const md = fakeMediaDevices();
    const first = deferred();
    md.script(() => first.promise);
    const { camera } = setup({ mediaDevices: md });
    const a = camera.start();
    await flush();
    const b = camera.start();
    await flush();
    expect(md.calls).toHaveLength(1); // the second request has not been made yet
    first.resolve(fakeStream());
    expect(await a).toMatchObject({ stale: true });
    expect(await b).toEqual({ ok: true });
    expect(md.calls).toHaveLength(2);
    expect(md.maxInFlight).toBe(1);
  });
});

describe('track ended and disconnect', () => {
  it('a track ending stops the session, detaches video, and reports disconnect without a new request', async () => {
    const { camera, md, video, lost } = setup();
    await camera.start();
    const stream = video.srcObject;
    const calls = md.calls.length;
    stream.track.fire('ended');
    expect(lost).toEqual([{ reason: 'ended' }]);
    expect(stream.track.stopped).toBe(true);
    expect(video.srcObject).toBeNull();
    expect(md.calls).toHaveLength(calls);
  });

  it('an ended event from a stream already stopped by stop() does not report a disconnect', async () => {
    const { camera, video, lost } = setup();
    await camera.start();
    const stream = video.srcObject;
    camera.stop();
    stream.track.fire('ended');
    expect(lost).toEqual([]);
  });
});

describe('stop', () => {
  it('stop releases the tracks and clears srcObject', async () => {
    const { camera, video } = setup();
    await camera.start();
    const stream = video.srcObject;
    camera.stop();
    expect(stream.track.stopped).toBe(true);
    expect(video.srcObject).toBeNull();
  });

  it('stop with nothing running is a no-op', () => {
    const { camera, video } = setup();
    expect(() => camera.stop()).not.toThrow();
    expect(video.srcObject).toBeNull();
  });
});
