// Skeleton capsules from MediaPipe Pose Landmarker results, rasterized on the CPU at mask resolution
// and unioned into the processed coverage of effects 1, 3, 4 and 6 (never the raw mask). Pure, no DOM.
//
// A pose sample is { sampledAt, frameTime, poses } where poses is the 33 landmarks of one person in
// source-normalized coordinates (row 0 at the top), or null. Each landmark carries visibility and
// presence. A shape is drawn only when every landmark it needs passes the gate, so a limb the model
// cannot see is not invented. Nothing is blurred: covered pixels are solid 255.
//
// Geometry is in mask pixels, so a circle stays round on a 16:9 mask. Sizes come from the shoulder
// width in mask pixels, so they scale with the person.

/** A pose result older than this at the segmentation time is ignored. */
export const POSE_STALE_MS = 250;
/** Minimum visibility and presence for a landmark to be used. */
export const POSE_GATE = 0.5;

// MediaPipe Pose landmark indices (33-point BlazePose topology).
export const POSE = {
  NOSE: 0,
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_ELBOW: 13, R_ELBOW: 14,
  L_WRIST: 15, R_WRIST: 16,
  L_HIP: 23, R_HIP: 24,
  L_KNEE: 25, R_KNEE: 26,
  L_ANKLE: 27, R_ANKLE: 28,
};

// Radii as fractions of the shoulder width.
const HEAD_RADIUS = 0.32;
const NECK_RADIUS = 0.14;
const UPPER_ARM_RADIUS = 0.13;
const FOREARM_RADIUS = 0.1;
const THIGH_RADIUS = 0.2;
const SHIN_RADIUS = 0.14;
const MIN_SHOULDER_PX = 2;

/** Returns the sample while it is fresh at `at`, otherwise null. */
export function poseFresh(sample, at, maxAgeMs = POSE_STALE_MS) {
  if (!sample || !sample.poses) return null;
  return at - sample.sampledAt <= maxAgeMs ? sample : null;
}

/** A landmark may be used when it is finite and passes both visibility and presence gates. */
export function poseVisible(lm) {
  if (!lm || !Number.isFinite(lm.x) || !Number.isFinite(lm.y)) return false;
  if (!(lm.visibility >= POSE_GATE)) return false;
  return lm.presence === undefined || lm.presence >= POSE_GATE;
}

/**
 * The shapes one pose contributes, in raster pixels of a w x h mask, or null when the torso cannot be
 * trusted (shoulders or hips missing, or the shoulders collapsed). Returns
 * `{ torso: [4 points] | null, discs: [{x, y, r}], capsules: [{ax, ay, bx, by, r}] }`.
 */
export function poseShapes(landmarks, w, h) {
  if (!landmarks || landmarks.length < 29) return null;
  const px = (i) => ({ x: landmarks[i].x * w, y: landmarks[i].y * h });
  const need = (...ids) => ids.every((i) => poseVisible(landmarks[i]));

  if (!need(POSE.L_SHOULDER, POSE.R_SHOULDER, POSE.L_HIP, POSE.R_HIP)) return null;
  const ls = px(POSE.L_SHOULDER);
  const rs = px(POSE.R_SHOULDER);
  const sw = Math.hypot(ls.x - rs.x, ls.y - rs.y);
  if (sw < MIN_SHOULDER_PX) return null;

  const shapes = {
    torso: [ls, rs, px(POSE.R_HIP), px(POSE.L_HIP)],
    discs: [],
    capsules: [],
  };
  const shoulderMid = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };

  if (poseVisible(landmarks[POSE.NOSE])) {
    const nose = px(POSE.NOSE);
    shapes.discs.push({ x: nose.x, y: nose.y, r: HEAD_RADIUS * sw });
    shapes.capsules.push({ ax: shoulderMid.x, ay: shoulderMid.y, bx: nose.x, by: nose.y, r: NECK_RADIUS * sw });
  }

  const limb = (a, b, r) => {
    if (!need(a, b)) return;
    const pa = px(a);
    const pb = px(b);
    shapes.capsules.push({ ax: pa.x, ay: pa.y, bx: pb.x, by: pb.y, r });
  };
  limb(POSE.L_SHOULDER, POSE.L_ELBOW, UPPER_ARM_RADIUS * sw);
  limb(POSE.L_ELBOW, POSE.L_WRIST, FOREARM_RADIUS * sw);
  limb(POSE.R_SHOULDER, POSE.R_ELBOW, UPPER_ARM_RADIUS * sw);
  limb(POSE.R_ELBOW, POSE.R_WRIST, FOREARM_RADIUS * sw);
  limb(POSE.L_HIP, POSE.L_KNEE, THIGH_RADIUS * sw);
  limb(POSE.L_KNEE, POSE.L_ANKLE, SHIN_RADIUS * sw);
  limb(POSE.R_HIP, POSE.R_KNEE, THIGH_RADIUS * sw);
  limb(POSE.R_KNEE, POSE.R_ANKLE, SHIN_RADIUS * sw);
  return shapes;
}

// Convex quad test: the point is inside when it is on the same side of all four edges.
function inConvexQuad(q, x, y) {
  let pos = false;
  let neg = false;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (cross > 0) pos = true;
    else if (cross < 0) neg = true;
    if (pos && neg) return false;
  }
  return true;
}

function distToSegmentSq(c, x, y) {
  const dx = c.bx - c.ax;
  const dy = c.by - c.ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - c.ax) * dx + (y - c.ay) * dy) / len2)) : 0;
  const ex = x - (c.ax + t * dx);
  const ey = y - (c.ay + t * dy);
  return ex * ex + ey * ey;
}

/**
 * Raises `out` (w*h bytes) to 255 wherever a shape of this pose covers a pixel centre. Never lowers a
 * byte, so it is a union with whatever the segmenter and persistence already wrote. Returns the number
 * of pixels it raised. A null pose or an untrusted torso paints nothing.
 */
export function paintPose(landmarks, w, h, out) {
  const shapes = poseShapes(landmarks, w, h);
  if (!shapes) return 0;
  let raised = 0;
  const set = (x, y) => {
    const i = y * w + x;
    if (out[i] !== 255) {
      out[i] = 255;
      raised++;
    }
  };
  const boxes = [];
  const quadBox = (pts) => ({
    x0: Math.min(...pts.map((p) => p.x)), x1: Math.max(...pts.map((p) => p.x)),
    y0: Math.min(...pts.map((p) => p.y)), y1: Math.max(...pts.map((p) => p.y)),
  });
  boxes.push({ box: quadBox(shapes.torso), test: (x, y) => inConvexQuad(shapes.torso, x, y) });
  for (const d of shapes.discs) {
    boxes.push({
      box: { x0: d.x - d.r, x1: d.x + d.r, y0: d.y - d.r, y1: d.y + d.r },
      test: (x, y) => (x - d.x) ** 2 + (y - d.y) ** 2 <= d.r * d.r,
    });
  }
  for (const c of shapes.capsules) {
    boxes.push({
      box: {
        x0: Math.min(c.ax, c.bx) - c.r, x1: Math.max(c.ax, c.bx) + c.r,
        y0: Math.min(c.ay, c.by) - c.r, y1: Math.max(c.ay, c.by) + c.r,
      },
      test: (x, y) => distToSegmentSq(c, x, y) <= c.r * c.r,
    });
  }
  for (const { box, test } of boxes) {
    const xs = Math.max(0, Math.floor(box.x0));
    const xe = Math.min(w - 1, Math.ceil(box.x1));
    const ys = Math.max(0, Math.floor(box.y0));
    const ye = Math.min(h - 1, Math.ceil(box.y1));
    for (let y = ys; y <= ye; y++) {
      for (let x = xs; x <= xe; x++) {
        if (test(x + 0.5, y + 0.5)) set(x, y);
      }
    }
  }
  return raised;
}

/** Pose calls run every this many video frames at best (lowest share after segmentation and hands). */
export const POSE_BASE_STRIDE = 3;
/** Pose is skipped while its own call time or the hand + segmentation calls exceed these. */
export const POSE_CALL_MS = [
  { maxMs: 8, stride: POSE_BASE_STRIDE },
  { maxMs: 16, stride: 6 },
  { maxMs: 30, stride: 12 },
];
export const POSE_WORK_BUDGET_MS = 24;
/** While skipped, one probe call every this many frames re-measures the pose cost. */
export const POSE_PROBE_FRAMES = 60;

/**
 * Video frames between pose calls, from the measured pose EMA and the hand + segmentation call time
 * of the same frame. 0 means skip (re-probed every POSE_PROBE_FRAMES). Pure and monotone in poseMs.
 */
export function poseStrideFor(poseMs, workMs = 0) {
  if (!(poseMs >= 0)) return POSE_BASE_STRIDE;
  if (workMs > POSE_WORK_BUDGET_MS) return 0;
  for (const band of POSE_CALL_MS) if (poseMs <= band.maxMs) return band.stride;
  return 0;
}
