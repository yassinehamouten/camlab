/* Approximate extended-finger counting for one hand (21 MediaPipe landmarks).
   A finger is extended when its tip is clearly farther from the wrist
   than the joint right below it. */

export function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
}

export function countExtendedFingers(lms) {
  const pairs = [[8, 6], [12, 10], [16, 14], [20, 18]];
  let n = 0;
  for (const [tip, pip] of pairs) {
    if (dist(lms[tip], lms[0]) > dist(lms[pip], lms[0]) * 1.12) n++;
  }
  if (dist(lms[4], lms[0]) > dist(lms[3], lms[0]) * 1.05) n++; // thumb (approximate)
  return n;
}
