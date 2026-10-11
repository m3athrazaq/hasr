// Monte-Carlo test of the tracker + counting line on simulated sheep flows with realistic
// detector failures (misses, jitter, merged boxes, false positives, low fps, back-and-forth).
import { Tracker } from '../js/engine/tracker.js';
import { LineCounter } from '../js/engine/counter.js';

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
const iou = (a, b) => {
  const ix = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1), iy = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
  if (ix <= 0 || iy <= 0) return 0;
  const i = ix * iy; return i / ((a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - i);
};

export function simulate(cfg, seed = 1) {
  const r = rng(seed);
  const W = 1280, H = 720, LINE_X = 640;
  const sheep = [];
  let nextArrival = 0;
  const T = cfg.duration;
  const dtSim = 1 / 60;
  const lanes = cfg.lanes;
  const laneY = (k) => H / 2 + (k - (lanes - 1) / 2) * (H * 0.7 / Math.max(1, lanes));
  const frames = [];
  let tFrame = 0;
  const frameDt = 1 / cfg.fps;
  for (let t = 0; t < T + 8; t += dtSim) {
    if (t < T && t >= nextArrival) {
      const lane = Math.floor(r() * lanes);
      const len = 110 + 30 * r() * cfg.sizeVar, wid = 60 + 20 * r() * cfg.sizeVar;
      sheep.push({
        x: -len, y: laneY(lane) + gauss(r) * cfg.yJitter, len, wid,
        v: Math.max(60, cfg.speed + gauss(r) * cfg.speed * 0.25), vy: 0,
        mode: 'walk', modeUntil: 0, startSide: -1, done: false,
      });
      nextArrival = t + (-Math.log(1 - r()) / cfg.rate);
    }
    const live = sheep.filter((s) => !s.done);
    for (const s of live) s.x0 = s.x;
    for (const s of live) {
      if (t >= s.modeUntil) {
        const u = r();
        if (s.mode !== 'walk') { s.mode = 'walk'; s.modeUntil = t + 0.5 + r() * 2; }
        else if (u < cfg.pStop * dtSim * 60) { s.mode = 'stop'; s.modeUntil = t + 0.3 + r() * 1.5; }
        else if (u < (cfg.pStop + cfg.pBack) * dtSim * 60 && s.x > LINE_X - 250 && s.x < LINE_X + 200) { s.mode = 'back'; s.modeUntil = t + 0.4 + r() * 1.2; }
      }
      const v = s.mode === 'walk' ? s.v : s.mode === 'back' ? -0.6 * s.v : 0;
      s.x += v * dtSim;
      s.vy += gauss(r) * 8 * dtSim; s.vy *= 0.98;
      s.y = Math.min(H - 30, Math.max(30, s.y + s.vy * dtSim * 20));
    }
    // bodies cannot overlap much: resolve contacts (rear animal yields, small sideways push)
    for (let it = 0; it < 3; it++) {
      live.sort((a, b) => b.x - a.x);
      for (let i = 0; i < live.length; i++) {
        for (let j = i + 1; j < live.length; j++) {
          const a = live[i], b = live[j]; // a is ahead (larger x)
          const ox = (a.len + b.len) / 2 * 0.92 - (a.x - b.x);
          const dy = b.y - a.y;
          const oy = (a.wid + b.wid) / 2 * 0.85 - Math.abs(dy);
          if (ox > 0 && oy > 0) {
            if (ox < oy * 1.5) { b.x -= ox; }
            else { const push = Math.min(oy, 6) / 2; const sgn = dy >= 0 ? 1 : -1; b.y += sgn * push; a.y -= sgn * push; }
          }
        }
      }
    }
    for (const s of live) {
      s.y = Math.min(H - 30, Math.max(30, s.y));
      if ((s.x0 - LINE_X) * (s.x - LINE_X) < 0 || (s.x0 < LINE_X) !== (s.x < LINE_X)) (s.cross ||= []).push([t, s.x > s.x0 ? 1 : -1]);
      if (s.x - s.len / 2 > W + 40) s.done = true;
    }
    if (t >= tFrame) {
      const boxes = [];
      const gt = [];
      for (const s of sheep) {
        if (s.done) continue;
        const b = { x1: s.x - s.len / 2, y1: s.y - s.wid / 2, x2: s.x + s.len / 2, y2: s.y + s.wid / 2 };
        if (b.x2 < 0 || b.x1 > W) continue;
        gt.push({ s, b, gid: sheep.indexOf(s) });
      }
      const merged = new Set();
      for (let i = 0; i < gt.length; i++) {
        const a = gt[i];
        if (merged.has(i)) continue;
        let occl = 0;
        for (let j = 0; j < gt.length; j++) if (j !== i) occl = Math.max(occl, iou(a.b, gt[j].b));
        // merged detection of two overlapping sheep
        if (occl > cfg.mergeIou && r() < cfg.pMerge) {
          let jBest = -1, best = 0;
          for (let j = 0; j < gt.length; j++) if (j !== i && !merged.has(j)) { const v = iou(a.b, gt[j].b); if (v > best) { best = v; jBest = j; } }
          if (jBest >= 0) {
            const b2 = gt[jBest].b;
            merged.add(i); merged.add(jBest);
            boxes.push({ x1: Math.min(a.b.x1, b2.x1), y1: Math.min(a.b.y1, b2.y1), x2: Math.max(a.b.x2, b2.x2), y2: Math.max(a.b.y2, b2.y2), score: 0.45 + 0.4 * r(), gid: -2 });
            continue;
          }
        }
        const pDet = occl > 0.2 ? cfg.pDetOccl : cfg.pDet;
        if (r() > pDet) continue;
        const n = cfg.boxNoise;
        const bb = {
          x1: Math.max(0, a.b.x1 + gauss(r) * n), y1: Math.max(0, a.b.y1 + gauss(r) * n),
          x2: Math.min(W, a.b.x2 + gauss(r) * n), y2: Math.min(H, a.b.y2 + gauss(r) * n),
          score: Math.min(0.97, Math.max(0.05, (occl > 0.2 ? 0.45 : 0.75) + gauss(r) * 0.15)), gid: a.gid,
        };
        if (bb.x2 - bb.x1 > 8) boxes.push(bb);
      }
      if (r() < cfg.pFalse) {
        const x = r() * (W - 100), y = r() * (H - 60);
        boxes.push({ x1: x, y1: y, x2: x + 60 + r() * 60, y2: y + 40 + r() * 30, score: 0.2 + 0.35 * r(), gid: -1 });
      }
      frames.push({ t: tFrame + (cfg.tJitter ? gauss(r) * cfg.tJitter : 0), boxes });
      tFrame += frameDt * (cfg.fpsVar ? 1 + (r() - 0.5) * cfg.fpsVar : 1);
    }
  }
  const gtCount = sheep.filter((s) => s.x > LINE_X).length;
  return { frames, gtCount, W, H, LINE_X, nSheep: sheep.length, sheep };
}

export function runEngine(sim, trackerOpts = {}, counterOpts = {}) {
  const tracker = new Tracker(trackerOpts);
  const counter = new LineCounter(counterOpts);
  counter.setFrame(sim.W, sim.H);
  counter.setLine({ x1: sim.LINE_X / sim.W, y1: 0.02, x2: sim.LINE_X / sim.W, y2: 0.98 }, 1);
  if (trackerOpts.flowHint) tracker.setFlow(...counter.forward());
  const events = [];
  let lastT = 0;
  for (const f of sim.frames) {
    const { tracks, events: tev } = tracker.step(f.boxes, f.t);
    events.push(...counter.update(tracks, tev, f.t));
    lastT = f.t;
  }
  // let lost tracks expire and flush orphans
  for (let k = 1; k <= 40; k++) {
    const t = lastT + k * 0.1;
    const { tracks, events: tev } = tracker.step([], t);
    events.push(...counter.update(tracks, tev, t));
  }
  events.push(...counter.finish(lastT + 5));
  const crosses = events.filter((e) => e.kind === 'cross');
  const flags = [];
  for (const e of events) {
    if (e.kind === 'flag') flags.push({ type: e.type, suggest: e.suggest });
    if (e.kind === 'cross') for (const f of e.flags) flags.push({ type: f.type, suggest: f.suggest });
  }
  const auto = counter.auto;
  const allAccepted = auto + flags.reduce((a, f) => a + f.suggest, 0);
  return { auto, allAccepted, flags, nCross: crosses.length, fwd: counter.fwd, back: counter.back };
}

export const SCEN = {
  sparse:   { duration: 120, rate: 1.0, lanes: 1, yJitter: 15, speed: 260, pStop: 0.004, pBack: 0.004, pDet: 0.93, pDetOccl: 0.7, boxNoise: 4, mergeIou: 0.35, pMerge: 0.02, pFalse: 0.01, fps: 12, sizeVar: 1 },
  medium:   { duration: 120, rate: 3.0, lanes: 2, yJitter: 30, speed: 240, pStop: 0.006, pBack: 0.006, pDet: 0.9, pDetOccl: 0.6, boxNoise: 5, mergeIou: 0.3, pMerge: 0.03, pFalse: 0.02, fps: 12, sizeVar: 1 },
  dense:    { duration: 120, rate: 6.0, lanes: 4, yJitter: 40, speed: 220, pStop: 0.008, pBack: 0.008, pDet: 0.88, pDetOccl: 0.55, boxNoise: 6, mergeIou: 0.3, pMerge: 0.05, pFalse: 0.03, fps: 12, sizeVar: 1 },
  lowfps:   { duration: 120, rate: 3.0, lanes: 2, yJitter: 30, speed: 300, pStop: 0.006, pBack: 0.006, pDet: 0.88, pDetOccl: 0.55, boxNoise: 6, mergeIou: 0.3, pMerge: 0.03, pFalse: 0.02, fps: 6, sizeVar: 1, fpsVar: 0.5 },
  backforth:{ duration: 120, rate: 2.0, lanes: 2, yJitter: 30, speed: 240, pStop: 0.01, pBack: 0.03, pDet: 0.9, pDetOccl: 0.6, boxNoise: 5, mergeIou: 0.3, pMerge: 0.03, pFalse: 0.02, fps: 10, sizeVar: 1 },
  poordet:  { duration: 120, rate: 3.0, lanes: 2, yJitter: 30, speed: 240, pStop: 0.006, pBack: 0.006, pDet: 0.7, pDetOccl: 0.4, boxNoise: 9, mergeIou: 0.3, pMerge: 0.06, pFalse: 0.06, fps: 10, sizeVar: 1 },
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const seeds = Number(process.argv[2] || 6);
  const only = process.argv[3];
  for (const [name, cfg] of Object.entries(SCEN)) {
    if (only && name !== only) continue;
    let gtSum = 0, errAbs = 0, errAccAbs = 0, nFlags = 0, worst = 0; const signed = [];
    const byType = {};
    for (let s = 1; s <= seeds; s++) {
      const sim = simulate(cfg, s * 7919);
      const res = runEngine(sim);
      gtSum += sim.gtCount;
      const e = res.auto - sim.gtCount;
      signed.push(e); errAbs += Math.abs(e); worst = Math.max(worst, Math.abs(e));
      errAccAbs += Math.abs(res.allAccepted - sim.gtCount);
      nFlags += res.flags.length;
      for (const f of res.flags) byType[f.type] = (byType[f.type] || 0) + 1;
    }
    const acc = 100 * (1 - errAbs / gtSum);
    console.log(`${name.padEnd(10)} sheep=${String(gtSum).padStart(5)}  auto-acc=${acc.toFixed(2)}%  mean|err|=${(errAbs / seeds).toFixed(1)} worst=${worst}  flags=${(100 * nFlags / gtSum).toFixed(1)}%  ${JSON.stringify(byType)}  all-accepted |err|=${(errAccAbs / seeds).toFixed(1)}  errs=${signed.join(',')}`);
  }
}
