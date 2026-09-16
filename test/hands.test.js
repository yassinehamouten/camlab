import { describe, it, expect } from "vitest";
import { countExtendedFingers } from "../src/lib/hands.js";

function lm(x, y) {
  return { x, y, z: 0 };
}

/* 21-point hand: wrist (0) at the bottom, chains thumb 1-2-3-4, index 5-6-7-8, etc. */
function handFixture({ tipY, pipY, thumbTipY, thumbIpY }) {
  const lms = Array.from({ length: 21 }, () => lm(0.5, 0.8));
  lms[0] = lm(0.5, 0.8); // wrist
  const chains = [
    [5, 6, 7, 8],     // index
    [9, 10, 11, 12],  // middle
    [13, 14, 15, 16], // ring
    [17, 18, 19, 20], // pinky
  ];
  for (const [mcp, pip, dip, tip] of chains) {
    lms[mcp] = lm(0.5, 0.7);
    lms[pip] = lm(0.5, pipY);
    lms[dip] = lm(0.5, (pipY + tipY) / 2);
    lms[tip] = lm(0.5, tipY);
  }
  lms[1] = lm(0.55, 0.75);
  lms[2] = lm(0.5, 0.72);
  lms[3] = lm(0.5, thumbIpY);
  lms[4] = lm(0.5, thumbTipY);
  return lms;
}

describe("countExtendedFingers", () => {
  it("open hand → 5 fingers", () => {
    const open = handFixture({ tipY: 0.3, pipY: 0.55, thumbTipY: 0.55, thumbIpY: 0.68 });
    expect(countExtendedFingers(open)).toBe(5);
  });

  it("closed fist → 0 fingers", () => {
    const fist = handFixture({ tipY: 0.75, pipY: 0.7, thumbTipY: 0.73, thumbIpY: 0.7 });
    expect(countExtendedFingers(fist)).toBe(0);
  });

  it("four fingers extended, thumb tucked in → 4", () => {
    const four = handFixture({ tipY: 0.3, pipY: 0.55, thumbTipY: 0.71, thumbIpY: 0.7 });
    expect(countExtendedFingers(four)).toBe(4);
  });
});
