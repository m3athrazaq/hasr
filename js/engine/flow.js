// Learns where the sheep walk and proposes a counting line across their path. Pure logic (no DOM):
// also used in tests.
//
// Sheep usually come down a race (a narrow passage) and then spread out, turn and mill around in a
// pen. The best place to count is inside the race: every animal crosses it once, in one direction,
// in single file. So instead of drawing the line through the middle of all motion, candidate lines
// across the main walking direction are scored by how many tracks cross them in the walking direction
// (minus those crossing back), and how narrow the band of crossing points is.

export class FlowLearner {
  constructor() { this.traj = new Map(); this.W = 1; this.H = 1; }
  reset() { this.traj.clear(); }

  add(tracks, W, H) {
    this.W = W; this.H = H;
    for (const tr of tracks) {
      if (tr.state !== 'confirmed' || !tr.updated) continue;
      const h = tr.hist[tr.hist.length - 1];
      let T = this.traj.get(tr.id);
      if (!T) {
        T = [];
        this.traj.set(tr.id, T);
        for (const p of tr.hist.slice(0, -1)) T.push([p.cx, p.cy, Math.sqrt(Math.max(1, p.a)), p.t]);
      }
      const last = T[T.length - 1];
      if (!last || h.t > last[3]) T.push([h.cx, h.cy, Math.sqrt(Math.max(1, h.a)), h.t]);
      if (T.length > 400) T.splice(0, T.length - 300);
    }
    if (this.traj.size > 600) {
      const ids = [...this.traj.keys()];
      for (const id of ids.slice(0, ids.length - 400)) this.traj.delete(id);
    }
  }

  // main walking direction from tracks that clearly moved: unit vector + how many tracks voted
  _direction() {
    let sx = 0, sy = 0, wsum = 0, n = 0;
    for (const T of this.traj.values()) {
      if (T.length < 4) continue;
      const a = T[0], b = T[T.length - 1];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.hypot(dx, dy), size = median(T.map((p) => p[2]));
      if (len < 0.6 * size) continue;
      const w = Math.min(3, len / size);
      sx += (w * dx) / len; sy += (w * dy) / len; wsum += w; n++;
    }
    const R = Math.hypot(sx, sy);
    if (n < 3 || R < 1e-6) return null;
    return { ux: sx / R, uy: sy / R, n, coherence: R / wsum };
  }

  // { line (normalised), dir, n, score } once a passage is clear, else null
  suggest() {
    const d0 = this._direction();
    if (!d0) return null;
    const trajs = [...this.traj.values()].filter((T) => T.length >= 2);
    const size = median(trajs.flatMap((T) => T.map((p) => p[2])));
    if (!size) return null;
    let best = null;
    const base = Math.atan2(d0.uy, d0.ux);
    for (const dAng of [-30, -15, 0, 15, 30]) {
      const ang = base + (dAng * Math.PI) / 180;
      const ux = Math.cos(ang), uy = Math.sin(ang), px = -uy, py = ux;
      const along = trajs.flatMap((T) => T.map((p) => p[0] * ux + p[1] * uy));
      const lo = quantile(along, 0.05), hi = quantile(along, 0.95);
      for (let a = lo; a <= hi; a += 0.2 * size) {
        const r = this._crossings(trajs, ux, uy, px, py, a);
        if (r.fwd < 3) continue;
        const width = r.across.length >= 3 ? quantile(r.across, 0.9) - quantile(r.across, 0.1) : size;
        const narrow = Math.max(0.25, Math.min(1, (1.5 * size) / Math.max(width, 0.5 * size)));
        const score = (r.fwd - 2 * r.back) * narrow - 0.02 * Math.abs(dAng) / 15;
        if (!best || score > best.score) best = { score, ux, uy, px, py, a, across: r.across, fwd: r.fwd, back: r.back };
      }
    }
    if (!best || best.score < 2) return null;
    const { ux, uy, px, py, a } = best;
    const c0 = quantile(best.across, 0.03) - 0.7 * size, c1 = quantile(best.across, 0.97) + 0.7 * size;
    const seg = clipToFrame(ux * a + px * c0, uy * a + py * c0, ux * a + px * c1, uy * a + py * c1, this.W, this.H);
    if (!seg) return null;
    const [x1, y1, x2, y2] = seg;
    const L = Math.hypot(x2 - x1, y2 - y1) || 1;
    // the counter's forward normal is (ly, -lx) * dir: make it point the way the sheep walk
    const dot = ((y2 - y1) / L) * ux + (-(x2 - x1) / L) * uy;
    return { line: { x1: x1 / this.W, y1: y1 / this.H, x2: x2 / this.W, y2: y2 / this.H }, dir: dot >= 0 ? 1 : -1, n: best.fwd, score: best.score };
  }

  // per track, the net way it crossed the line {p.u = a}: +1 along u, -1 back, 0 not at all / both
  _crossings(trajs, ux, uy, px, py, a) {
    let fwd = 0, back = 0;
    const across = [];
    for (const T of trajs) {
      let net = 0, c = null;
      for (let i = 0; i + 1 < T.length; i++) {
        const p = T[i], q = T[i + 1];
        if (q[3] - p[3] > 1.5) continue; // too long a gap to trust the path
        const sa = p[0] * ux + p[1] * uy - a, sb = q[0] * ux + q[1] * uy - a;
        if ((sa < 0) === (sb < 0)) continue;
        net += sb > sa ? 1 : -1;
        if (c === null) {
          const f = sa / (sa - sb);
          c = (p[0] + f * (q[0] - p[0])) * px + (p[1] + f * (q[1] - p[1])) * py;
        }
      }
      if (net > 0) { fwd++; across.push(c); } else if (net < 0) back++;
    }
    return { fwd, back, across };
  }
}

function median(arr) { return arr.length ? quantile(arr, 0.5) : 0; }
function quantile(arr, f) {
  const s = arr.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(f * (s.length - 1))))];
}

// Liang-Barsky clipping of a segment to the frame (with a small margin)
function clipToFrame(x1, y1, x2, y2, W, H) {
  const m = 0.01;
  const xmin = W * m, ymin = H * m, xmax = W * (1 - m), ymax = H * (1 - m);
  let t0 = 0, t1 = 1;
  const dx = x2 - x1, dy = y2 - y1;
  for (const [p, q] of [[-dx, x1 - xmin], [dx, xmax - x1], [-dy, y1 - ymin], [dy, ymax - y1]]) {
    if (p === 0) { if (q < 0) return null; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return [x1 + t0 * dx, y1 + t0 * dy, x1 + t1 * dx, y1 + t1 * dy];
}
