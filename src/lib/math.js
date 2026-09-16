/* Pure math helpers (unit-tested with Vitest) */

export const clamp01 = (v) => Math.max(0, Math.min(1, v));

export const dot = (f, c) => f.reduce((s, v, i) => s + v * c[i], 0);

/* Solve a linear system with Gauss-Jordan elimination and partial pivoting */
export function gaussSolve(M, b) {
  const n = b.length;
  const Aug = M.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(Aug[r][col]) > Math.abs(Aug[piv][col])) piv = r;
    }
    [Aug[col], Aug[piv]] = [Aug[piv], Aug[col]];
    const p = Aug[col][col] || 1e-9;
    for (let c = col; c <= n; c++) Aug[col][c] /= p;
    for (let r = 0; r < n; r++) {
      if (r === col || !Aug[r][col]) continue;
      const f = Aug[r][col];
      for (let c = col; c <= n; c++) Aug[r][c] -= f * Aug[col][c];
    }
  }
  return Aug.map((row) => row[n]);
}

/* Linear regression via normal equations + ridge:
   find c minimizing ||A·c − b||² (A: n samples × nCoef features) */
export function solveLinear(A, b, nCoef) {
  const AtA = Array.from({ length: nCoef }, () => new Array(nCoef).fill(0));
  const Atb = new Array(nCoef).fill(0);
  for (let i = 0; i < A.length; i++) {
    for (let r = 0; r < nCoef; r++) {
      Atb[r] += A[i][r] * b[i];
      for (let c = 0; c < nCoef; c++) AtA[r][c] += A[i][r] * A[i][c];
    }
  }
  for (let r = 0; r < nCoef; r++) AtA[r][r] += 1e-6;
  return gaussSolve(AtA, Atb);
}
