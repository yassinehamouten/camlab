import { clamp01, solveLinear, dot } from "./math.js";

/* Pure gaze-tracking logic: metrics from landmarks, model features and
   9-point calibration regression (unit-tested with Vitest). */

export const CAL_POINTS = [4, 0, 2, 6, 8, 1, 3, 5, 7]; // center, then corners, then cross
export const CAL_MOVE_MS = 700;     // time to bring your gaze to the dot
export const CAL_COLLECT_MS = 1100; // sampling time per dot

/* yaw: nose position between the cheeks; pitch: vertical squash of the face;
   gx/gy: iris position between the corners and eyelids of each eye */
export function gazeMetrics(lms) {
  const nose = lms[1], cheekL = lms[234], cheekR = lms[454];
  const forehead = lms[10], chin = lms[152];
  const yaw = (nose.x - cheekL.x) / Math.max(1e-6, cheekR.x - cheekL.x);
  const dTop = Math.hypot(forehead.x - nose.x, forehead.y - nose.y);
  const dBot = Math.hypot(chin.x - nose.x, chin.y - nose.y);
  const pitch = dTop / Math.max(1e-6, dTop + dBot);
  const irisA = lms[468], irisB = lms[473];
  const gx = ((irisA.x - lms[33].x) / Math.max(1e-6, lms[133].x - lms[33].x) +
              (irisB.x - lms[362].x) / Math.max(1e-6, lms[263].x - lms[362].x)) / 2;
  const gy = ((irisA.y - lms[159].y) / Math.max(1e-6, lms[145].y - lms[159].y) +
              (irisB.y - lms[386].y) / Math.max(1e-6, lms[374].y - lms[386].y)) / 2;
  return { yaw, pitch, gx, gy };
}

/* eyes → [gx, gy, 1] · head → [gx, gy, yaw, pitch, 1] */
export function gazeFeatures(m, source) {
  if (source === "eyes") return [clamp01(m.gx), clamp01(m.gy), 1];
  return [clamp01(m.gx), clamp01(m.gy), m.yaw, m.pitch, 1];
}

export const gazeFeaturesLength = (source) => (source === "eyes" ? 3 : 5);

/* Learn the raw-signal → screen mapping from calibration samples.
   samples: [{ f: number[], x, y }] · returns { coefX, coefY, rms } */
export function fitGazeModel(samples, source) {
  const nc = gazeFeaturesLength(source);
  const fs = samples.map((s) => s.f);
  const coefX = solveLinear(fs, samples.map((s) => s.x), nc);
  const coefY = solveLinear(fs, samples.map((s) => s.y), nc);
  let se = 0;
  for (const s of samples) {
    se += (dot(s.f, coefX) - s.x) ** 2 + (dot(s.f, coefY) - s.y) ** 2;
  }
  const rms = Math.sqrt(se / (samples.length * 2));
  return { coefX, coefY, rms };
}
