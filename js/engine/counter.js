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
  oversize: 1.6,       // box area above this multiple of a typical sheep, with two animals seen inside it, is flagged "maybe 2 sheep"
  oversizeAlone: 2.2,  // ... or above this multiple even without that evidence
  lowConf: 0.32,       // crossings by tracks never above this score are flagged
  relinkFlagGap: 0.7,  // re-linked crossings after a gap longer than this (s) are flagged
  minSizeSamples: 20,
  warmup: 1.0,         // seconds after a (re)start in which animals already past the line are not "appearing"
  birthSide: 0.15,     // a track first seen this far into the dead band (fraction of it) starts on that side
  inheritBand: 1.5,    // a track first seen within this many dead bands of the line, where a not yet counted
  inheritDist: 0.6,    //   track was lost (within this many sheep lengths, at most inheritGap seconds ago),
  inheritGap: 3.0,     //   continues that sheep: it still has to cross
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

  // tracking restarted (pause, stall): what is visible next was not "born" there
  restart() { this.st.clear(); this.births = []; this.deaths = []; this.startT = null; }

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

  // unit vector (px) pointing to the destination side: the way counted animals walk
  forward() { const g = this._geom(); return [g.nx, g.ny]; }

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
    if (this.startT == null) this.startT = t;

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
            box: ev.box, vel: ev.vel, crossed: s.crossed, stSide: s.side, decideAt: t + this.o.orphanWindow });
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
        // a sheep standing on the line is often lost and picked up again under a new id: if this track
        // starts right where a not yet counted one was lost, it is that sheep - it is still on the
        // source side and must be counted once it walks over
        const heir = Math.abs(g0.d) <= this.o.inheritBand * this.bandPx() && this.inSeg(g0.s) ? this._uncountedLost(tr, h0, tracks, t) : null;
        if (heir) {
          st.side = -1;
          if (heir.death) this.deaths = this.deaths.filter((x) => x !== heir.death);
        } else if (Math.abs(g0.d) >= this.o.birthSide * this.bandPx() && this.inSeg(g0.s) && !this._recounted(tr, h0, tracks, t)) {
          // first seen inside the dead band but clearly on one side: start from that side, so a sheep
          // that first shows up just before the line and walks over it is still counted - unless it
          // may be an already counted sheep picked up again (a counted track was lost right there)
          st.side = g0.d < 0 ? -1 : 1;
        }
        this.st.set(tr.id, st);
        if (!heir && Math.abs(g0.d) < near && this.inSeg(g0.s) && st.born - this.startT >= this.o.warmup) {
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

  // the nearest track lost (or given up) in the last few seconds right where this one starts, that was
  // still on the source side and not counted
  _uncountedLost(tr, h0, tracks, t) {
    if (!h0) return null;
    const len = this.sheepLen() || 0.12 * Math.min(this.W, this.H);
    let best = null, bestD = this.o.inheritDist * len;
    for (const o of tracks) {
      if (o === tr || o.state !== 'lost' || t - o.lastSeen > this.o.inheritGap) continue;
      const so = this.st.get(o.id);
      if (!so || so.side !== -1 || so.crossed > 0) continue;
      const [x, y] = center(o.box);
      const dd = Math.hypot(h0.cx - x, h0.cy - y);
      if (dd < bestD) { bestD = dd; best = { id: o.id }; }
    }
    for (const dth of this.deaths) {
      if (dth.stSide !== -1 || dth.crossed > 0 || t - dth.t > this.o.inheritGap) continue;
      const [x, y] = center(dth.box);
      const dd = Math.hypot(h0.cx - x, h0.cy - y);
      if (dd < bestD) { bestD = dd; best = { id: dth.id, death: dth }; }
    }
    return best;
  }

  _recounted(tr, h0, tracks, t) {
    if (!h0) return false;
    const len = this.sheepLen() || 0.12 * Math.min(this.W, this.H);
    // the new track starts where a counted, now lost, sheep was (or a little ahead of it, never well behind)
    const same = (b, vel, reach = 1) => {
      const [x, y] = center(b);
      const dx = h0.cx - x, dy = h0.cy - y;
      if (Math.hypot(dx, dy) >= reach * len) return false;
      const sp = Math.hypot(vel?.[0] || 0, vel?.[1] || 0);
      return sp < 1e-3 || (dx * vel[0] + dy * vel[1]) / sp / len > -0.35;
    };
    for (const o of tracks) {
      if (o === tr || o.state !== 'lost') continue;
      const so = this.st.get(o.id);
      if (so && so.crossed && same(o.box, o.velocity())) return true;
    }
    // a track given up on a moment ago: only if the new one starts right where it was
    return this.deaths.some((d) => d.crossed && t - d.t < 1.6 && same(d.box, d.vel, 0.6));
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
      // big sheep and sheep turning sideways are common: a large box alone is weak evidence
      if ((ratio >= this.o.oversize && (tr.split || 0) >= 1) || ratio >= this.o.oversizeAlone) {
        flags.push({ type: 'merge', suggest: Math.max(1, Math.round(ratio) - 1), ratio, split: tr.split || 0 });
      }
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
