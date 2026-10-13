// Multi-object tracker for sheep (ByteTrack-style two-stage association + motion re-linking).
// Pure JS, no DOM: used by the app in the browser and by the Node test harness.
import { hungarian } from './hungarian.js';
import { BoxKF, setNoise } from './kalman.js';

const BIG = 1e6;
const SURE_MARGIN = 0.2;

export function iou(a, b) {
  const ix = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
  const iy = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
  if (ix <= 0 || iy <= 0) return 0;
  const inter = ix * iy;
  const u = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
  return u > 0 ? inter / u : 0;
}
export const area = (b) => Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
const inter = (a, b) => Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)) * Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
export const center = (b) => [(b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2];
const diag = (b) => Math.hypot(b.x2 - b.x1, b.y2 - b.y1);
const toZ = (b) => [(b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2, b.x2 - b.x1, b.y2 - b.y1];

// how far detection d lies behind box a along unit direction dir, in box diagonals (>0 = behind)
function backwards(a, d, dir) {
  const [ax, ay] = center(a);
  const [dx, dy] = center(d);
  return -((dx - ax) * dir[0] + (dy - ay) * dir[1]) / Math.max(1e-6, 0.5 * (diag(a) + diag(d)));
}

function normDist(a, b) {
  const [ax, ay] = center(a);
  const [bx, by] = center(b);
  return Math.hypot(ax - bx, ay - by) / Math.max(1e-6, 0.5 * (diag(a) + diag(b)));
}

export const TRACKER_DEFAULTS = {
  fps: 15,              // nominal frame rate the noise model is tuned for
  lowThr: 0.12,         // detections below this are ignored
  highThr: 0.42,        // first-stage (confident) detections
  newThr: 0.5,          // minimum score to start a new track
  matchIou: 0.15,       // stage-1 IoU gate; below it a distance gate is used
  distGate: 0.55,       // stage-1 normalised centre-distance gate (grows while lost)
  secondIou: 0.3,       // stage-2 (low-score) IoU gate
  tentativeIou: 0.25,   // gate for unconfirmed tracks
  nInit: 2,             // hits needed to confirm a track
  tentativeAge: 0.45,   // seconds an unconfirmed track may go unseen before it is dropped
  maxAge: 1.2,          // seconds a lost track is kept
  relinkGap: 1.2,       // max seconds between a lost track and a new one to re-link them
  relinkDist: 0.6,      // max normalised distance for re-linking
  historyLen: 24,
  sp: 1 / 20,           // Kalman position noise weight
  sv: 1 / 160,          // Kalman velocity noise weight
  mixCost: 0.0,         // weight of centre distance added to the IoU cost (helps at low fps)
  maxBack: Infinity,    // optional: a non-overlapping match may not lie further than this (normalised) behind
                        // the track's heading. Off by default: sheep that turn back at low frame rates need it off
  movingSpeed: 0.15,    // normalised speed (box diagonals per second) above which a track has a heading
  claimIou: 0.3,        // a detection overlapping another track this much belongs to that track
  dupIou: 0.5,          // no new track from a detection overlapping a track updated this frame (duplicate box)
  sureIou: 0.5,         // track/box pairs that are each other's best overlap above this are matched first
  partIn: 0.8,          // no new track from a box lying this much inside a followed animal (a part of it)
  claimWeak: 0.5,       // ... and an overlap below this does not take a box another track overlaps
  claimRatio: 2,        //     at least this many times better
  relinkBack: 0.35,     // a lost track is not re-linked to an animal this far (normalised) behind its heading
  tentBack: 0.5,        // an unconfirmed track does not jump this far (normalised) against the walking direction
};

class Track {
  constructor(id, det, t, fps) {
    this.id = id;
    this.fps = fps;
    this.kf = new BoxKF(toZ(det));
    this.state = 'tentative';
    this.hits = 1;
    this.firstSeen = t;
    this.lastSeen = t;
    this.box = { x1: det.x1, y1: det.y1, x2: det.x2, y2: det.y2 };
    this.pred = this.box;
    this.score = det.score;
    this.maxScore = det.score;
    this.updated = true;
    this.hist = [{ t, cx: (det.x1 + det.x2) / 2, cy: (det.y1 + det.y2) / 2, a: area(det), s: det.score, g: det.gid }];
    this.split = 0; // frames in which two separate animals were seen inside this track's box
  }

  measure(det, t, histLen) {
    this.kf.update(toZ(det));
    if (this.hits === 1) {
      // second sighting: seed the velocity from the displacement so fast sheep are followed at once
      const h0 = this.hist[this.hist.length - 1];
      const dtf = Math.max(1e-3, t - h0.t) * this.fps;
      const z = toZ(det);
      this.kf.x[4] = (z[0] - h0.cx) / dtf;
      this.kf.x[5] = (z[1] - h0.cy) / dtf;
    }
    this.box = { x1: det.x1, y1: det.y1, x2: det.x2, y2: det.y2 };
    this.score = det.score;
    if (det.score > this.maxScore) this.maxScore = det.score;
    this.hits++;
    this.lastSeen = t;
    this.updated = true;
    this.hist.push({ t, cx: (det.x1 + det.x2) / 2, cy: (det.y1 + det.y2) / 2, a: area(det), s: det.score, g: det.gid });
    if (this.hist.length > histLen) this.hist.shift();
  }

  // velocity in px/s estimated from the last observations (robust to KF lag)
  velocity() {
    const h = this.hist;
    if (h.length < 2) return [0, 0];
    const a = h[Math.max(0, h.length - 5)], b = h[h.length - 1];
    const dt = b.t - a.t;
    if (dt <= 1e-3) return [0, 0];
    return [(b.cx - a.cx) / dt, (b.cy - a.cy) / dt];
  }
}

function associate(tracks, dets, costFn, sureIou = 0) {
  if (!tracks.length || !dets.length) return { matches: [], ut: tracks.slice(), ud: dets.slice() };
  const matches = [];
  const mt = new Set(), md = new Set();
  if (sureIou > 0) {
    // unambiguous pairs first: a track and a box that are each other's best overlap. Otherwise the
    // global optimum may hand a sheep's box to a neighbour whose own box is weak this frame, and
    // leave the sheep a fragment (head, half body) of itself.
    // (with a clear margin over every alternative, so only really unambiguous pairs are fixed)
    const V = tracks.map((tr) => dets.map((d) => iou(tr.pred, d)));
    for (let i = 0; i < tracks.length; i++) {
      let bj = -1, second = 0;
      for (let j = 0; j < dets.length; j++) {
        if (bj < 0 || V[i][j] > V[i][bj]) { if (bj >= 0) second = Math.max(second, V[i][bj]); bj = j; } else second = Math.max(second, V[i][j]);
      }
      if (bj < 0 || V[i][bj] < sureIou || V[i][bj] - second < SURE_MARGIN) continue;
      let ok = true;
      for (let k = 0; k < tracks.length; k++) if (k !== i && V[k][bj] > V[i][bj] - SURE_MARGIN) { ok = false; break; }
      if (!ok || md.has(bj) || costFn(tracks[i], dets[bj]) >= BIG) continue;
      matches.push([tracks[i], dets[bj]]);
      mt.add(i); md.add(bj);
    }
  }
  const ri = tracks.map((_, i) => i).filter((i) => !mt.has(i));
  const rj = dets.map((_, j) => j).filter((j) => !md.has(j));
  if (ri.length && rj.length) {
    const C = ri.map((i) => rj.map((j) => costFn(tracks[i], dets[j])));
    for (const [a, b] of hungarian(C)) {
      if (C[a][b] >= BIG) continue;
      matches.push([tracks[ri[a]], dets[rj[b]]]);
      mt.add(ri[a]); md.add(rj[b]);
    }
  }
  return {
    matches,
    ut: tracks.filter((_, i) => !mt.has(i)),
    ud: dets.filter((_, j) => !md.has(j)),
  };
}

export class Tracker {
  constructor(opts = {}) {
    this.o = { ...TRACKER_DEFAULTS, ...opts };
    setNoise(this.o.sp, this.o.sv);
    this.tracks = [];
    this.nextId = 1;
    this.t = null;
    this.flow = null; // expected walking direction (unit vector, px), e.g. across the counting line
  }

  // hint for tracks that are standing still: which way the animals are expected to walk
  setFlow(fx, fy) {
    const n = Math.hypot(fx, fy);
    this.flow = n > 1e-6 ? [fx / n, fy / n] : null;
  }

  reset() {
    this.tracks = [];
    this.t = null;
  }

  // dets: [{x1,y1,x2,y2,score}] in frame pixels; t: seconds (monotonic)
  // returns { tracks, events } where events are {type:'confirmed'|'relink'|'lost'|'recovered'|'removed', ...}
  step(dets, t) {
    const o = this.o;
    const events = [];
    const dt = this.t == null ? 1 / o.fps : Math.min(5, Math.max(1e-3, t - this.t));
    this.t = t;
    const k = dt * o.fps;
    for (const tr of this.tracks) {
      tr.kf.predict(k);
      tr.pred = tr.kf.box();
      tr.updated = false;
    }

    const valid = dets.filter((d) => d.score >= o.lowThr && d.x2 - d.x1 > 2 && d.y2 - d.y1 > 2);
    const high = valid.filter((d) => d.score >= o.highThr);
    const low = valid.filter((d) => d.score < o.highThr);
    const active = this.tracks.filter((tr) => tr.state !== 'tentative');
    const tent = this.tracks.filter((tr) => tr.state === 'tentative');

    // a detection that clearly overlaps another track's prediction belongs to that track: a sheep whose
    // own box is weak this frame must not take its neighbour's box on a small overlap or by distance
    const bestOf = new Map();
    for (const d of high) {
      let bt = null, bv = 0;
      for (const tr of this.tracks) { const v = iou(tr.pred, d); if (v > bv) { bv = v; bt = tr; } }
      bestOf.set(d, { tr: bt, v: bv });
    }
    const claimedByOther = (d, tr, v = 0) => {
      const b = bestOf.get(d);
      return !!b && b.tr !== tr && b.v >= o.claimIou && b.v >= o.claimRatio * v + 0.05;
    };

    // Stage 1: confirmed + lost tracks vs confident detections (IoU, then distance for fast motion)
    const s1 = associate(active, high, (tr, d) => {
      const v = iou(tr.pred, d);
      if (v >= o.matchIou) {
        if (v < o.claimWeak && claimedByOther(d, tr, v)) return BIG;
        return 1 - v + (o.mixCost ? o.mixCost * normDist(tr.pred, d) : 0);
      }
      const ar = area(d) / Math.max(1, area(tr.pred));
      if (ar < 0.4 || ar > 2.5) return BIG;
      if (claimedByOther(d, tr)) return BIG;
      const tsu = t - tr.lastSeen;
      const head = this._heading(tr);
      // the gate widens while a moving track is unseen; a track standing still keeps a tight gate
      const gate = o.distGate * (1 + (head.moving ? Math.min(1, tsu / 0.6) : 0));
      const dn = normDist(tr.pred, d);
      if (dn >= gate) return BIG;
      if (head.dir && backwards(tr.box, d, head.dir) > o.maxBack) return BIG;
      return 1 + dn;
    }, o.sureIou);
    for (const [tr, d] of s1.matches) this._apply(tr, d, t, events);

    // Stage 2: still-tracked (not lost) tracks vs low-score detections
    const s2Tracks = s1.ut.filter((tr) => tr.state === 'confirmed');
    const s2 = associate(s2Tracks, low, (tr, d) => {
      const v = iou(tr.pred, d);
      return v >= o.secondIou ? 1 - v : BIG;
    });
    for (const [tr, d] of s2.matches) this._apply(tr, d, t, events);

    // Stage 3: tentative tracks vs remaining confident detections
    const s3 = associate(tent, s1.ud, (tr, d) => {
      const v = iou(tr.pred, d);
      if (v >= o.tentativeIou) return v < o.claimWeak && claimedByOther(d, tr, v) ? BIG : 1 - v;
      const ar = area(d) / Math.max(1, area(tr.pred));
      if (ar < 0.5 || ar > 2) return BIG;
      if (claimedByOther(d, tr)) return BIG;
      // unconfirmed tracks have no reliable velocity yet: allow a move proportional to the time unseen
      const tsu = t - tr.lastSeen;
      const dn = normDist(tr.pred, d);
      const gate = 0.35 + 0.9 * Math.min(1, tsu / 0.4);
      if (dn >= gate) return BIG;
      // an unconfirmed track has no motion of its own yet: a big jump against the expected walking
      // direction is another animal (or a box on a different part of the crowd)
      if (this.flow && backwards(tr.box, d, this.flow) > Math.min(o.maxBack, o.tentBack)) return BIG;
      return 1 + dn;
    }, o.sureIou);
    for (const [tr, d] of s3.matches) this._apply(tr, d, t, events);

    // Unmatched tentative tracks survive a short gap (weak detectors miss frames); confirmed become lost
    const dead = new Set();
    for (const tr of s3.ut) if (t - tr.lastSeen > o.tentativeAge) dead.add(tr);
    for (const tr of this.tracks) {
      if (tr.updated || tr.state === 'tentative') continue;
      if (tr.state === 'confirmed') {
        tr.state = 'lost';
        events.push({ type: 'lost', id: tr.id, t });
      }
      if (t - tr.lastSeen > o.maxAge) {
        dead.add(tr);
        events.push({ type: 'removed', id: tr.id, t, lastSeen: tr.lastSeen, box: tr.box, vel: tr.velocity(), hits: tr.hits });
      }
    }
    this.tracks = this.tracks.filter((tr) => !dead.has(tr));

    // New tracks from confident unmatched detections - but not from a second box on an animal already
    // followed in this frame, a box on part of it (head, front half), or a box around two of them
    const seen = this.tracks.filter((tr) => tr.updated);
    const redundant = (d) => {
      let around = 0;
      for (const tr of seen) {
        if (iou(tr.box, d) >= o.dupIou) return true;
        const i = inter(tr.box, d);
        if (i >= o.partIn * area(d) && area(d) <= 0.7 * area(tr.box)) return true;
        if (i >= o.partIn * 0.875 * area(tr.box)) around++;
      }
      return around >= 2;
    };
    for (const d of s3.ud) {
      if (d.score < o.newThr || redundant(d)) continue;
      this.tracks.push(new Track(this.nextId++, d, t, o.fps));
    }

    // Confirmation (+ re-linking to a recently lost track so identity survives occlusions)
    for (const tr of this.tracks.slice()) {
      if (tr.state !== 'tentative' || tr.hits < o.nInit || !tr.updated) continue;
      const cand = this._relinkCandidate(tr, t);
      if (cand) {
        const gap = t - cand.lastSeen;
        cand.kf = tr.kf.clone();
        cand.box = tr.box;
        cand.pred = tr.box;
        cand.score = tr.score;
        cand.maxScore = Math.max(cand.maxScore, tr.maxScore);
        cand.hits += tr.hits;
        cand.split += tr.split;
        cand.lastSeen = t;
        cand.updated = true;
        cand.state = 'confirmed';
        for (const h of tr.hist) cand.hist.push(h);
        while (cand.hist.length > o.historyLen) cand.hist.shift();
        this.tracks = this.tracks.filter((x) => x !== tr);
        events.push({ type: 'relink', id: cand.id, fromId: tr.id, gap, t });
      } else {
        tr.state = 'confirmed';
        events.push({ type: 'confirmed', id: tr.id, t });
      }
    }
    // evidence that a box holds two animals: two separate smaller boxes inside it (side by side or
    // one behind the other). Used by the counter to ask for a review of such crossings.
    for (const tr of this.tracks) {
      if (!tr.updated || tr.state !== 'confirmed') continue;
      const A = area(tr.box);
      const sub = valid.filter((d) => area(d) <= 0.75 * A && inter(d, tr.box) >= 0.7 * area(d));
      let two = false;
      for (let i = 0; i < sub.length && !two; i++) {
        for (let j = i + 1; j < sub.length; j++) {
          if (iou(sub[i], sub[j]) < 0.2 && area(sub[i]) + area(sub[j]) >= 0.5 * A) { two = true; break; }
        }
      }
      if (two) tr.split++;
    }
    return { tracks: this.tracks, events };
  }

  _apply(tr, d, t, events) {
    const wasLost = tr.state === 'lost';
    const gap = t - tr.lastSeen;
    tr.measure(d, t, this.o.historyLen);
    if (wasLost) {
      tr.state = 'confirmed';
      events.push({ type: 'recovered', id: tr.id, gap, t });
    }
  }

  // direction a track is heading: its own motion when it moves, else the expected flow (if known)
  _heading(tr) {
    const [vx, vy] = tr.velocity();
    const sp = Math.hypot(vx, vy);
    if (sp > 1e-6 && sp / Math.max(1, diag(tr.box)) > this.o.movingSpeed) return { dir: [vx / sp, vy / sp], moving: true };
    return { dir: this.flow, moving: false };
  }

  _relinkCandidate(tr, t) {
    const o = this.o;
    let best = null, bestD = Infinity;
    for (const c of this.tracks) {
      if (c.state !== 'lost') continue;
      const gap = t - c.lastSeen;
      if (gap > o.relinkGap) continue;
      const ar = area(tr.box) / Math.max(1, area(c.box));
      if (ar < 0.35 || ar > 2.8) continue;
      // predicted position: last measurement + recent velocity * gap (bounded)
      const [vx, vy] = c.velocity();
      const [lx, ly] = center(c.box);
      const g = Math.min(gap, 0.8);
      const px = lx + vx * g, py = ly + vy * g;
      const [nx, ny] = center(tr.box);
      const size = 0.5 * (diag(c.box) + diag(tr.box));
      const dPred = Math.hypot(nx - px, ny - py) / size;
      const dLast = Math.hypot(nx - lx, ny - ly) / size;
      const dn = Math.min(dPred, dLast * 1.15);
      if (dn >= o.relinkDist) continue;
      // prefer the most recently lost track and motion that continues its previous heading
      const sp = Math.hypot(vx, vy);
      let back = 0;
      if (sp > 1e-3) {
        const along = ((nx - lx) * vx + (ny - ly) * vy) / sp / size;
        if (along < -0.15) back = -along;
      } else if (this.flow) {
        const along = ((nx - lx) * this.flow[0] + (ny - ly) * this.flow[1]) / size;
        if (along < -0.15) back = -along;
      }
      if (back > o.relinkBack) continue; // a lost sheep does not reappear behind where it was going
      const cost = dn + 0.6 * gap / o.relinkGap + 1.5 * back;
      if (cost < bestD) { best = c; bestD = cost; }
    }
    return best;
  }
}
