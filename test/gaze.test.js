import { describe, it, expect } from "vitest";
import {
  CAL_POINTS, CAL_MOVE_MS, CAL_COLLECT_MS,
  gazeMetrics, gazeFeatures, gazeFeaturesLength, fitGazeModel,
} from "../src/lib/gaze.js";

/* Build a synthetic 478-point face with controlled geometry */
function lm(x, y) {
  return { x, y, z: 0 };
}

function faceFixture(overrides = []) {
  const lms = Array.from({ length: 478 }, () => lm(0.5, 0.5));
  lms[1] = lm(0.5, 0.5);       // nose
  lms[234] = lm(0.2, 0.5);     // left cheek
  lms[454] = lm(0.8, 0.5);     // right cheek
  lms[10] = lm(0.5, 0.2);      // forehead
  lms[152] = lm(0.5, 0.8);     // chin
  lms[33] = lm(0.3, 0.45);     // eye A outer corner
  lms[133] = lm(0.4, 0.45);    // eye A inner corner
  lms[362] = lm(0.6, 0.45);    // eye B inner corner
  lms[263] = lm(0.7, 0.45);    // eye B outer corner
  lms[159] = lm(0.35, 0.42);   // eye A upper lid
  lms[145] = lm(0.35, 0.48);   // eye A lower lid
  lms[386] = lm(0.65, 0.42);   // eye B upper lid
  lms[374] = lm(0.65, 0.48);   // eye B lower lid
  lms[468] = lm(0.35, 0.45);   // iris A (center)
  lms[473] = lm(0.65, 0.45);   // iris B (center)
  for (const [i, x, y] of overrides) lms[i] = lm(x, y);
  return lms;
}

describe("gazeMetrics", () => {
  it("neutral face → yaw/pitch/gx/gy all at 0.5", () => {
    const m = gazeMetrics(faceFixture());
    expect(m.yaw).toBeCloseTo(0.5, 10);
    expect(m.pitch).toBeCloseTo(0.5, 10);
    expect(m.gx).toBeCloseTo(0.5, 10);
    expect(m.gy).toBeCloseTo(0.5, 10);
  });

  it("nose turned toward the right cheek increases yaw", () => {
    const m = gazeMetrics(faceFixture([[1, 0.65, 0.5]]));
    expect(m.yaw).toBeCloseTo(0.75, 10); // (0.65-0.2)/0.6
  });

  it("irises shifted right increase gx", () => {
    const m = gazeMetrics(faceFixture([[468, 0.37, 0.45], [473, 0.67, 0.45]]));
    expect(m.gx).toBeCloseTo(0.7, 10); // average of both eyes: 0.7
  });

  it("irises moved up decrease gy", () => {
    const m = gazeMetrics(faceFixture([[468, 0.35, 0.43], [473, 0.65, 0.43]]));
    // iris at (0.43−0.42)/(0.48−0.42) = 1/6 above the eyelids
    expect(m.gy).toBeCloseTo(1 / 6, 10);
  });
});

describe("gazeFeatures", () => {
  it("eyes source → 3 features (gx, gy, bias)", () => {
    const f = gazeFeatures({ yaw: 0.5, pitch: 0.5, gx: 0.4, gy: 0.6 }, "eyes");
    expect(f).toHaveLength(3);
    expect(f[2]).toBe(1);
    expect(gazeFeaturesLength("eyes")).toBe(3);
  });

  it("head source → 5 features (gx, gy, yaw, pitch, bias)", () => {
    const f = gazeFeatures({ yaw: 0.5, pitch: 0.5, gx: 0.4, gy: 0.6 }, "head");
    expect(f).toHaveLength(5);
    expect(f[4]).toBe(1);
    expect(gazeFeaturesLength("head")).toBe(5);
  });
});

describe("fitGazeModel", () => {
  it("recovers a known affine mapping (signal → screen)", () => {
    // true mapping: x = 3·gx − 0.2 ; y = −2·gy + 1.2
    const samples = [];
    for (let i = 0; i < 60; i++) {
      const gx = 0.35 + (i % 10) * 0.03;
      const gy = 0.4 + Math.floor(i / 10) * 0.05;
      const f = [gx, gy, 1];
      samples.push({ f, x: 3 * gx - 0.2, y: -2 * gy + 1.2 });
    }
    const { coefX, coefY, rms } = fitGazeModel(samples, "eyes");
    expect(coefX[0]).toBeCloseTo(3, 4);  // 1e-6 ridge → ~1e-5 accuracy
    expect(coefX[2]).toBeCloseTo(-0.2, 4);
    expect(coefY[1]).toBeCloseTo(-2, 4);
    expect(coefY[2]).toBeCloseTo(1.2, 4);
    expect(rms).toBeLessThan(1e-3);
  });

  it("the head model absorbs head (yaw) pollution correlated with the screen", () => {
    // yaw pollutes x: x = 3·gx + 1·yaw − 2.0
    const samples = [];
    for (let i = 0; i < 45; i++) {
      const gx = 0.35 + (i % 9) * 0.03;
      const yaw = 0.4 + Math.floor(i / 9) * 0.05;
      const f = [gx, 0.5, yaw, 0.5, 1];
      samples.push({ f, x: 3 * gx + yaw - 2.0, y: 0.5 });
    }
    const { coefX, rms } = fitGazeModel(samples, "head");
    expect(coefX[0]).toBeCloseTo(3, 4);  // gaze weight
    expect(coefX[2]).toBeCloseTo(1, 4);  // head weight
    expect(rms).toBeLessThan(1e-3);
  });
});

describe("calibration constants", () => {
  it("9 points, all within the 3×3 grid, positive durations", () => {
    expect(CAL_POINTS).toHaveLength(9);
    for (const p of CAL_POINTS) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(8);
    }
    expect(new Set(CAL_POINTS).size).toBe(9); // each cell used exactly once
    expect(CAL_MOVE_MS).toBeGreaterThan(0);
    expect(CAL_COLLECT_MS).toBeGreaterThan(CAL_MOVE_MS);
  });
});
