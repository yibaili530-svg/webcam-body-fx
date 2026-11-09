// Default camera and stream lifecycle. Every browser API is injected, so tests drive this with
// fakes. It owns the tracks it opens and the video element's srcObject; nothing else stops them.
//
// Generation guard: every start and stop bumps `gen`. A request that finishes after a newer one
// (or a stop) sees the mismatch, stops its own tracks and leaves the element alone.
// Requests are serialized, so two getUserMedia calls never overlap.

const SIZE = { width: 1280, height: 720 };

/** Front camera at 720p, no audio. */
export function buildConstraints() {
  return { video: { facingMode: 'user', ...SIZE }, audio: false };
}

export function classifyError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError': return 'denied';
    case 'NotFoundError':
    case 'DevicesNotFoundError': return 'missing';
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError': return 'overconstrained';
    case 'NotReadableError':
    case 'TrackStartError': return 'busy';
    default: return 'other';
  }
}

export function createCameraController({ mediaDevices, video, onLost = () => {} }) {
  let gen = 0;
  let owned = null;              // stream whose tracks this controller must stop
  let queue = Promise.resolve(); // serializes getUserMedia calls

  function stopOwned() {
    const stream = owned;
    owned = null;
    if (video.srcObject) video.srcObject = null;
    stream?.getTracks().forEach((track) => track.stop());
  }

  function run(task) {
    const next = queue.then(task);
    queue = next.catch(() => {});
    return next;
  }

  async function attempt(my) {
    if (my !== gen) return { ok: false, stale: true };
    stopOwned(); // the old camera must release before the new request

    let constraints = buildConstraints();
    for (let tries = 0; ; tries++) {
      let stream;
      try {
        stream = await mediaDevices.getUserMedia(constraints);
      } catch (err) {
        if (my !== gen) return { ok: false, stale: true };
        const kind = classifyError(err);
        // One bounded retry with relaxed size, and only for an overconstrained request. A denial never retries.
        if (tries === 0 && kind === 'overconstrained') {
          constraints = { video: { facingMode: 'user' }, audio: false };
          continue;
        }
        return { ok: false, kind, error: err };
      }

      if (my !== gen) {
        stream.getTracks().forEach((track) => track.stop());
        return { ok: false, stale: true };
      }

      owned = stream;
      // A track ending means the device was unplugged or revoked. Only the current stream counts.
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (owned !== stream) return;
        gen++;
        stopOwned();
        onLost({ reason: 'ended' });
      });
      video.srcObject = stream;
      try {
        await video.play();
      } catch (err) {
        if (my !== gen) return { ok: false, stale: true };
        stopOwned();
        return { ok: false, kind: 'other', error: err };
      }
      if (my !== gen) return { ok: false, stale: true };

      return { ok: true };
    }
  }

  return {
    start() {
      const my = ++gen;
      return run(() => attempt(my));
    },
    stop() {
      gen++;
      stopOwned();
    },
  };
}
