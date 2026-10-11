// Learns which way the sheep walk from confirmed tracks and proposes a counting line straight
// across their path, through the middle of where they are seen. Pure logic (no DOM): also used in tests.

export class FlowLearner {
  constructor() { this.tracks = new Map(); this.pts = []; this.W = 1; this.H = 1; }
  reset() { this.tracks.clear(); this.pts = []; }
  add(tracks, W, H) {
    this.W = W; this.H = H;
    for (const tr of tracks) {
      if (tr.state !== 'confirmed' || !tr.updated || tr.hist.length < 4) continue;
      const a = tr.hist[0], b = tr.hist[tr.hist.length - 1];
      const size = Math.sqrt(Math.max(1, b.a));
      this.tracks.set(tr.id, { dx: b.cx - a.cx, dy: b.cy - a.cy, size });
      this.pts.push([b.cx, b.cy, size]);
    }
    if (this.pts.length > 4000) this.pts.splice(0, this.pts.length - 3000);
  }
  // { line (normalised), dir, n } once the motion is clear, else null
  suggest() {
    let sx = 0, sy = 0, wsum = 0, n = 0;
    for (const v of this.tracks.values()) {
      const len = Math.hypot(v.dx, v.dy);
      if (len < 0.6 * v.size) continue;
      const w = Math.min(3, len / v.size);
      sx += (w * v.dx) / len; sy += (w * v.dy) / len; wsum += w; n++;
    }
    if (n < 4 || wsum < 4) return null;
    const R = Math.hypot(sx, sy);
    if (R / wsum < 0.65) return null;
    const ux = sx / R, uy = sy / R;   // walking direction
    const px = -uy, py = ux;          // across the passage
    const along = [], across = [], sizes = [];
    for (const [x, y, sz] of this.pts) { along.push(x * ux + y * uy); across.push(x * px + y * py); sizes.push(sz); }
    const q = (arr, f) => { const s2 = arr.slice().sort((a, b) => a - b); return s2[Math.min(s2.length - 1, Math.max(0, Math.round(f * (s2.length - 1))))]; };
    const a0 = 0.5 * (q(along, 0.1) + q(along, 0.9)), size = q(sizes, 0.5);
    const c0 = q(across, 0.03) - 0.7 * size, c1 = q(across, 0.97) + 0.7 * size;
    const seg = clipToFrame(ux * a0 + px * c0, uy * a0 + py * c0, ux * a0 + px * c1, uy * a0 + py * c1, this.W, this.H);
    if (!seg) return null;
    const [x1, y1, x2, y2] = seg;
    const L = Math.hypot(x2 - x1, y2 - y1) || 1;
    // the counter's forward normal is (ly, -lx) * dir: make it point the way the sheep walk
    const dot = ((y2 - y1) / L) * ux + (-(x2 - x1) / L) * uy;
    return { line: { x1: x1 / this.W, y1: y1 / this.H, x2: x2 / this.W, y2: y2 / this.H }, dir: dot >= 0 ? 1 : -1, n };
  }
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
