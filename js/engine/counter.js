// Counting line with hysteresis, net (bidirectional) counting, and review flags.
// A track adds +1 when it moves from the source side (A) to the destination side (B)
// and -1 when it moves back, so sheep that hesitate or turn around are never double counted.
import { area, center } from './tracker.js';

export const COUNTER_DEFAULTS = {
  band: 0.02,          // half-width of the dead band around the line, fraction of min(W,H)
  bandBySize: 0.12,    // ... or this fraction of the median sheep length, whichever is larger
  segMargin: 0.1,      // crossings may happen this far beyond the drawn segment ends (fraction of its length)
  nearBySize: 1.2,     // "near the line" distance for orphan analysis, in sheep lengths
  orphanWindow: 2.5,   // seconds to look for an explanation of an orphan birth/death
  oversize: 1.6,       // box area above this multiple of a typical sheep is flagged "maybe 2 sheep"
  lowConf: 0.32,       // crossings by tracks never above this score are flagged
  relinkFlagGap: 0.7,  // re-linked crossings after a gap longer than this (s) are flagged
  minSizeSamples: 20,
};

const median = (arr) => {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
};

export class LineCounter {
  constructor(opts = {}) {
    this.o = { ...COUNTER_DEFAULTS, ...opts };
    this.line = { x1: 0.5, y1: 0.05, x2: 0.5, y2: 0.95 }; // normalised
    this.dir = 1;
    this.W = 1; this.H = 1;
    this.st = new Map();
    this.sizes = [];      // recent sheep areas near the line
    this.lens = [];       // recent sheep lengths (long side)
    this.births = [];     // pending orphan births near the line
    this.deaths = [];     // pending orphan deaths near the line
    this.auto = 0;        // automatic net count
    this.fwd = 0;         // forward crossings
    this.back = 0;        // backward crossings
    this.seq = 0;
    this._geomCache = null;
  }

  setLine(line, dir = 1) { this.line = { ...line }; this.dir = dir >= 0 ? 1 : -1; this._geomCache = null; }
  setFrame(W, H) { if (W !== this.W || H !== this.H) { this.W = W; this.H = H; this._geomCache = null; } }

  _geom() {
    if (this._geomCache) return this._geomCache;
    const { W, H, line } = this;
    const p1x = line.x1 * W, p1y = line.y1 * H, p2x = line.x2 * W, p2y = line.y2 * H;
    const L = Math.max(1e-6, Math.hypot(p2x - p1x, p2y - p1y));
    const ux = (p2x - p1x) / L, uy = (p2y - p1y) / L;
    const nx = uy * this.dir, ny = -ux * this.dir;
    this._geomCache = { p1x, p1y, L, ux, uy, nx, ny };
    return this._geomCache;
  }

  // signed distance (px, +ve = destination side) and position along the segment (0..1)
  locate(px, py) {
    const g = this._geom();
    const dx = px - g.p1x, dy = py - g.p1y;
    return { d: dx * g.nx + dy * g.ny, s: (dx * g.ux + dy * g.uy) / g.L };
  }

  sheepLen() { return this.lens.length >= this.o.minSizeSamples ? median(this.lens) : 0; }
  sheepArea() { return this.sizes.length >= this.o.minSizeSamples ? median(this.sizes) : 0; }
  bandPx() {
    return Math.max(3, this.o.band * Math.min(this.W, this.H), this.o.bandBySize * this.sheepLen());
  }
  nearPx() {
    const len = this.sheepLen() || 0.12 * Math.min(this.W, this.H);
    return Math.min(0.3 * Math.min(this.W, this.H), Math.max(3 * this.bandPx(), this.o.nearBySize * len));
  }
  inSeg(s) { return s >= -this.o.segMargin && s <= 1 + this.o.segMargin; }

  zone(d) {
    const b = this.bandPx();
    return d < -b ? -1 : d > b ? 1 : 0;
  }

  // tracks: tracker.tracks; tevents: tracker events of this step; t: seconds
  // returns emitted events: {kind:'cross'|'flag', ...}
  update(tracks, tevents, t) {
    const out = [];
    const near = this.nearPx();

    for (const ev of tevents) {
      if (ev.type === 'relink') {
        const s = this.st.get(ev.fromId);
        const dst = this.st.get(ev.id);
        if (dst) dst.relinkGap = ev.gap;
        if (s) this.st.delete(ev.fromId);
      } else if (ev.type === 'removed') {
        const s = this.st.get(ev.id);
        this.st.delete(ev.id);
        if (!s) continue;
        if (Math.abs(s.lastD) < near && this.inSeg(s.lastS)) {
          this.deaths.push({ id: ev.id, t: ev.lastSeen, side: s.lastD < 0 ? -1 : 1, d: s.lastD, s: s.lastS,
            box: ev.box, vel: ev.vel, crossed: s.crossed, decideAt: t + this.o.orphanWindow });
        }
      }
    }

    for (const tr of tracks) {
      if (tr.state !== 'confirmed' || !tr.updated) continue;
      const [cx, cy] = center(tr.box);
      const { d, s } = this.locate(cx, cy);
      let st = this.st.get(tr.id);
      if (!st) {
        // first time we see this confirmed track: replay its unconfirmed history so a sheep that
        // crossed while its track was still being confirmed is not lost
        const h0 = tr.hist[0];
        const g0 = h0 ? this.locate(h0.cx, h0.cy) : { d, s };
        st = { side: 0, born: h0 ? h0.t : t, bornD: g0.d, bornS: g0.s, crossed: 0, lastD: g0.d, lastS: g0.s, lastZone: 0, relinkGap: 0, maxScore: 0 };
        this.st.set(tr.id, st);
        if (Math.abs(g0.d) < near && this.inSeg(g0.s)) {
          this.births.push({ id: tr.id, t: st.born, side: g0.d < 0 ? -1 : 1, d: g0.d, s: g0.s, box: tr.box, decideAt: t + this.o.orphanWindow });
        }
        for (let i = 0; i < tr.hist.length - 1; i++) {
          const hp = tr.hist[i];
          const gp = this.locate(hp.cx, hp.cy);
          const zp = this.zone(gp.d);
          if (zp !== 0) {
            if (st.side === 0) st.side = zp;
            else if (zp !== st.side) {
              if (this.inSeg(0.5 * (st.lastS + gp.s))) out.push(this._cross(tr, st, zp > 0 ? 1 : -1, hp.t));
              st.side = zp;
            }
          }
          st.lastD = gp.d; st.lastS = gp.s; st.lastZone = zp;
        }
      }
      st.maxScore = Math.max(st.maxScore, tr.maxScore);
      const z = this.zone(d);
      if (z !== 0) {
        if (st.side === 0) st.side = z;
        else if (z !== st.side) {
          const sMid = 0.5 * (st.lastS + s);
          if (this.inSeg(sMid)) out.push(this._cross(tr, st, z > 0 ? 1 : -1, t));
          st.side = z;
        }
      }
      st.lastD = d; st.lastS = s; st.lastZone = z; st.lastSeenT = t;
      // learn the typical sheep size from clean, isolated observations near the line
      if (Math.abs(d) < 2 * near && tr.hits >= 3 && tr.score >= 0.5) {
        const w = tr.box.x2 - tr.box.x1, h = tr.box.y2 - tr.box.y1;
        this.sizes.push(w * h); this.lens.push(Math.max(w, h));
        if (this.sizes.length > 300) { this.sizes.shift(); this.lens.shift(); }
      }
    }

    out.push(...this._resolveOrphans(t));
    return out;
  }

  _cross(tr, st, dir, t) {
    st.crossed += dir;
    this.auto += dir;
    if (dir > 0) this.fwd++; else this.back++;
    const flags = [];
    const typical = this.sheepArea();
    if (dir > 0 && typical) {
      const recent = tr.hist.slice(-6).map((h) => h.a);
      const ratio = median(recent) / typical;
      if (ratio >= this.o.oversize) flags.push({ type: 'merge', suggest: Math.max(1, Math.round(ratio) - 1), ratio });
    }
    if (st.maxScore < this.o.lowConf) flags.push({ type: 'lowconf', suggest: -dir });
    if (st.relinkGap > this.o.relinkFlagGap) flags.push({ type: 'relink', suggest: 0, gap: st.relinkGap });
    st.relinkGap = 0;
    return { kind: 'cross', id: ++this.seq, track: tr.id, dir, t, box: { ...tr.box }, score: tr.maxScore, flags };
  }

  // Explain births/deaths near the line. A birth just past the line with no matching track loss
  // (or a loss just before it with no re-appearance) may hide a crossing the camera did not see.
  _resolveOrphans(t) {
    const out = [];
    const len = this.sheepLen() || 0.12 * Math.min(this.W, this.H);
    const g = this._geom();
    const consistent = (death, birth) => {
      const dtm = birth.t - death.t;
      if (dtm < -0.2 || dtm > this.o.orphanWindow) return Infinity;
      const [lx, ly] = center(death.box);
      const vx = death.vel?.[0] || 0, vy = death.vel?.[1] || 0;
      if (death.side !== birth.side) {
        // a hidden crossing needs the lost animal to have been heading for the line
        const vn = vx * g.nx + vy * g.ny; // +ve = towards the destination side
        if (Math.sign(vn) !== birth.side || Math.abs(vn) < 0.05 * len) return Infinity;
        if (death.crossed && Math.sign(death.crossed) === birth.side) return Infinity;
      }
      const gg = Math.max(0, Math.min(dtm, 0.8));
      const px = lx + vx * gg, py = ly + vy * gg;
      const [bx, by] = center(birth.box);
      return Math.min(Math.hypot(bx - px, by - py), Math.hypot(bx - lx, by - ly) * 1.3) / len;
    };
    // pair births with deaths (greedy, best first)
    const pairs = [];
    for (const b of this.births) for (const dd of this.deaths) {
      const c = consistent(dd, b);
      if (c < 1.0) pairs.push([c, b, dd]);
    }
    pairs.sort((a, b) => a[0] - b[0]);
    const usedB = new Set(), usedD = new Set();
    for (const [, b, dd] of pairs) {
      if (usedB.has(b) || usedD.has(dd)) continue;
      usedB.add(b); usedD.add(dd);
      // the birth continues the dead track: if they lie on opposite sides, a crossing was missed
      if (dd.side !== b.side) {
        const dir = b.side > 0 ? 1 : -1;
        out.push({ kind: 'flag', id: ++this.seq, t: b.t, type: 'gap', suggest: dir, tracks: [dd.id, b.id], box: b.box, at: b.t });
      }
    }
    this.births = this.births.filter((b) => !usedB.has(b));
    this.deaths = this.deaths.filter((d) => !usedD.has(d));

    // expire unexplained orphans: a sheep that appears just past the line out of nowhere
    const keepB = [];
    for (const b of this.births) {
      if (t < b.decideAt) { keepB.push(b); continue; }
      // only a real, persistent animal that appeared just past the line is worth a look
      const bSt = this.st.get(b.id);
      const persistent = !bSt || (bSt.lastSeenT ?? b.t) - b.t >= 0.5;
      if (b.side > 0 && persistent) out.push({ kind: 'flag', id: ++this.seq, t: b.t, type: 'appear', suggest: 1, tracks: [b.id], box: b.box, at: b.t });
    }
    this.births = keepB;
    // tracks lost just before the line are usually picked up again under another id: no flag,
    // they are only kept for pairing with a birth on the other side ("gap")
    this.deaths = this.deaths.filter((d) => t < d.decideAt);
    return out;
  }

  // flush pending orphans at the end of a session/video
  finish(t) {
    for (const b of this.births) b.decideAt = -Infinity;
    for (const d of this.deaths) d.decideAt = -Infinity;
    return this._resolveOrphans(t);
  }
}
