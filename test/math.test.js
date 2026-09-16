import { describe, it, expect } from "vitest";
import { clamp01, dot, gaussSolve, solveLinear } from "../src/lib/math.js";

describe("clamp01", () => {
  it("clamps to [0,1]", () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(0.42)).toBe(0.42);
    expect(clamp01(1.5)).toBe(1);
  });
});

describe("dot", () => {
  it("computes a dot product", () => {
    expect(dot([1, 2, 3], [4, 5, 6])).toBe(32);
  });
});

describe("gaussSolve", () => {
  it("solves an exact 2×2 system", () => {
    // x + y = 3 ; x − y = 1 → x=2, y=1
    const c = gaussSolve([[1, 1], [1, -1]], [3, 1]);
    expect(c[0]).toBeCloseTo(2, 10);
    expect(c[1]).toBeCloseTo(1, 10);
  });

  it("solves a 3×3 system requiring a pivot swap", () => {
    // 0x + 1y + 2z = 8 ; 2x + 0y + 1z = 6 ; 1x + 1y + 1z = 6 → x=y=4/3, z=10/3
    const c = gaussSolve([[0, 1, 2], [2, 0, 1], [1, 1, 1]], [8, 6, 6]);
    expect(c[0]).toBeCloseTo(4 / 3, 6);
    expect(c[1]).toBeCloseTo(4 / 3, 6);
    expect(c[2]).toBeCloseTo(10 / 3, 6);
  });
});

describe("solveLinear (least squares)", () => {
  it("recovers the exact line y = 2x + 1", () => {
    const A = [[0, 1], [1, 1], [2, 1], [3, 1]];
    const b = [1, 3, 5, 7];
    const [a, c] = solveLinear(A, b, 2);
    expect(a).toBeCloseTo(2, 4); // 1e-6 ridge → ~1e-7 accuracy
    expect(c).toBeCloseTo(1, 4);
  });

  it("best-fits noisy data (true LSQ: slope 2.26, intercept 0.36)", () => {
    const A = [[0, 1], [1, 1], [2, 1], [3, 1]];
    const b = [0, 3.2, 4.8, 7];
    const [a, c] = solveLinear(A, b, 2);
    expect(a).toBeCloseTo(2.26, 3);
    expect(c).toBeCloseTo(0.36, 3);
  });

  it("recovers an exact affine 3D plane", () => {
    // z = 1x − 2y + 0.5
    const A = [];
    const b = [];
    for (const x of [0, 1, 2]) {
      for (const y of [0, 1, 2]) {
        A.push([x, y, 1]);
        b.push(x - 2 * y + 0.5);
      }
    }
    const [cx, cy, c] = solveLinear(A, b, 3);
    expect(cx).toBeCloseTo(1, 5);
    expect(cy).toBeCloseTo(-2, 5);
    expect(c).toBeCloseTo(0.5, 5);
  });
});
