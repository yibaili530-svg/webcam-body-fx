import { describe, expect, it } from 'vitest';
import {
  paintPose, POSE, poseFresh, poseStrideFor, POSE_BASE_STRIDE, POSE_STALE_MS, poseShapes,
} from '../src/pose-capsules.js';

// Synthetic fixture (not footage): a 100 x 100 mask and hand-placed landmarks in normalized coordinates.
// Every landmark starts invisible (visibility 0), so each test shows exactly the points it sets.
const W = 100;
const H = 100;

function landmarks(points) {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0, presence: 0 }));
  for (const [i, x, y, visibility = 0.9, presence = 0.9] of points) lm[i] = { x, y, visibility, presence };
  return lm;
}

// Upright torso: shoulders 20 px apart at y 30, hips at y 80.
const TORSO = [
  [POSE.L_SHOULDER, 0.4, 0.3], [POSE.R_SHOULDER, 0.6, 0.3],
  [POSE.L_HIP, 0.42, 0.8], [POSE.R_HIP, 0.58, 0.8],
];

const paint = (lm) => {
  const out = new Uint8Array(W * H);
  const raised = paintPose(lm, W, H, out);
  return { out, raised };
};
const at = (out, x, y) => out[y * W + x];

describe('paintPose: torso', () => {
  it('fills the torso polygon solid and nothing outside it', () => {
    const { out } = paint(landmarks(TORSO));
    expect(at(out, 50, 50)).toBe(255);
    expect(at(out, 42, 79)).toBe(255);
    expect(at(out, 10, 50)).toBe(0);
    expect(at(out, 50, 10)).toBe(0);
    expect(at(out, 50, 90)).toBe(0);
  });

  it('draws nothing when a hip is not visible: the torso is not trusted', () => {
    const lm = landmarks(TORSO);
    lm[POSE.R_HIP] = { ...lm[POSE.R_HIP], visibility: 0.2 };
    const { out, raised } = paint(lm);
    expect(raised).toBe(0);
    expect(out.every((v) => v === 0)).toBe(true);
  });

  it('gates on presence as well as visibility', () => {
    const lm = landmarks(TORSO);
    lm[POSE.L_SHOULDER] = { ...lm[POSE.L_SHOULDER], presence: 0.3 };
    expect(poseShapes(lm, W, H)).toBeNull();
  });

  it('ignores non-finite coordinates instead of drawing them', () => {
    const lm = landmarks(TORSO);
    lm[POSE.L_HIP] = { x: Number.NaN, y: 0.8, visibility: 0.9, presence: 0.9 };
    expect(poseShapes(lm, W, H)).toBeNull();
  });
});

describe('paintPose: head and neck', () => {
  it('draws a head disc at the nose sized from the shoulder width', () => {
    // Shoulders 20 px apart, so the disc radius is 0.32 * 20 = 6.4 px.
    const lm = landmarks([...TORSO, [POSE.NOSE, 0.5, 0.2]]);
    const { out } = paint(lm);
    expect(at(out, 50, 20)).toBe(255);
    expect(at(out, 55, 20)).toBe(255); // 5 px from the nose
    expect(at(out, 58, 20)).toBe(0); // 8 px from the nose, beyond the disc
  });

  it('scales the head with the shoulders: a narrower person gets a smaller disc', () => {
    // Shoulders 10 px apart, so the radius is 3.2 px: the point 5 px away is outside.
    const narrow = landmarks([
      [POSE.L_SHOULDER, 0.45, 0.3], [POSE.R_SHOULDER, 0.55, 0.3],
      [POSE.L_HIP, 0.46, 0.8], [POSE.R_HIP, 0.54, 0.8],
      [POSE.NOSE, 0.5, 0.2],
    ]);
    const { out } = paint(narrow);
    expect(at(out, 50, 20)).toBe(255);
    expect(at(out, 55, 20)).toBe(0);
  });

  it('draws no head when the nose is not visible', () => {
    const { out } = paint(landmarks([...TORSO, [POSE.NOSE, 0.5, 0.2, 0.1]]));
    expect(at(out, 50, 20)).toBe(0);
  });
});

describe('paintPose: limb capsules and per-landmark gating', () => {
  it('draws a visible upper arm capsule between its two endpoints', () => {
    const lm = landmarks([...TORSO, [POSE.L_ELBOW, 0.2, 0.5]]);
    const { out } = paint(lm);
    // Midpoint of shoulder (40, 30) -> elbow (20, 50).
    expect(at(out, 30, 40)).toBe(255);
  });

  it('keeps the upper arm and drops the forearm when only the wrist is hidden', () => {
    const lm = landmarks([
      ...TORSO,
      [POSE.L_ELBOW, 0.2, 0.5],
      [POSE.L_WRIST, 0.1, 0.7, 0.2],
    ]);
    const { out } = paint(lm);
    expect(at(out, 30, 40)).toBe(255); // upper arm still drawn
    expect(at(out, 15, 60)).toBe(0); // forearm midpoint: the wrist is below the gate, so no limb
  });

  it('draws nothing for a limb whose visible endpoints are both missing', () => {
    const { out, raised } = paint(landmarks([...TORSO, [POSE.L_KNEE, 0.4, 0.95, 0.1]]));
    expect(raised).toBe(paint(landmarks(TORSO)).raised);
    expect(at(out, 41, 90)).toBe(0);
  });
});

describe('paintPose: union only', () => {
  it('raises covered pixels to 255 and never lowers any byte', () => {
    const out = new Uint8Array(W * H).fill(100);
    const raised = paintPose(landmarks(TORSO), W, H, out);
    expect(at(out, 50, 50)).toBe(255);
    expect(at(out, 10, 50)).toBe(100);
    expect(raised).toBeGreaterThan(0);
  });

  it('reports exactly the number of pixels it newly raised', () => {
    const out = new Uint8Array(W * H);
    const first = paintPose(landmarks(TORSO), W, H, out);
    const second = paintPose(landmarks(TORSO), W, H, out);
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(0);
  });

  it('returns 0 and writes nothing for a null pose', () => {
    const out = new Uint8Array(W * H);
    expect(paintPose(null, W, H, out)).toBe(0);
    expect(out.every((v) => v === 0)).toBe(true);
  });
});

describe('poseFresh', () => {
  const sample = { sampledAt: 1000, frameTime: 1, poses: landmarks(TORSO) };

  it('keeps a sample up to the stale limit, inclusive', () => {
    expect(poseFresh(sample, 1000 + POSE_STALE_MS)).toBe(sample);
  });

  it('drops a sample just past the stale limit', () => {
    expect(poseFresh(sample, 1000 + POSE_STALE_MS + 1)).toBeNull();
  });

  it('treats a sample with no person as absent', () => {
    expect(poseFresh({ sampledAt: 1000, poses: null }, 1000)).toBeNull();
    expect(poseFresh(null, 1000)).toBeNull();
  });
});

describe('poseStrideFor: scheduling share and adaptive skip', () => {
  it('uses the base stride while the pose call is cheap', () => {
    expect(poseStrideFor(4, 0)).toBe(POSE_BASE_STRIDE);
    expect(poseStrideFor(undefined, 0)).toBe(POSE_BASE_STRIDE);
  });

  it('skips pose when the hand and segmentation calls already fill the frame budget', () => {
    expect(poseStrideFor(4, 25)).toBe(0);
  });

  it('skips pose when the pose call itself is too slow', () => {
    expect(poseStrideFor(40, 0)).toBe(0);
  });

  it('never makes pose run more often as it gets slower', () => {
    let previous = 0;
    for (let ms = 0; ms <= 60; ms++) {
      const stride = poseStrideFor(ms, 0);
      if (stride === 0) continue;
      expect(stride).toBeGreaterThanOrEqual(previous);
      previous = stride;
    }
  });
});

describe('poseShapes', () => {
  it('returns null when the landmark list is too short', () => {
    expect(poseShapes([], W, H)).toBeNull();
  });
});
