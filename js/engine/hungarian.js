// Minimum-cost assignment (Kuhn–Munkres with potentials, O(n^2 m)).
// cost: array of rows (n x m). Returns [[row, col], ...] for every row (n<=m) or col (n>m).
// Use a large finite value (not Infinity) for forbidden pairs and filter them afterwards.
export function hungarian(cost) {
  let n = cost.length;
  if (!n) return [];
  let m = cost[0].length;
  if (!m) return [];
  let a = cost;
  let transposed = false;
  if (n > m) {
    transposed = true;
    a = Array.from({ length: m }, (_, j) => Array.from({ length: n }, (_, i) => cost[i][j]));
    [n, m] = [m, n];
  }
  const u = new Float64Array(n + 1);
  const v = new Float64Array(m + 1);
  const p = new Int32Array(m + 1);
  const way = new Int32Array(m + 1);
  const minv = new Float64Array(m + 1);
  const used = new Uint8Array(m + 1);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    minv.fill(Infinity);
    used.fill(0);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      const row = a[i0 - 1];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = row[j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const res = [];
  for (let j = 1; j <= m; j++) {
    if (p[j]) res.push(transposed ? [j - 1, p[j] - 1] : [p[j] - 1, j - 1]);
  }
  return res;
}
