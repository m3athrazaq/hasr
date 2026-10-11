// Parameter sweep over simulated scenarios: prints mean |error| and flag rate per setting.
import { simulate, runEngine } from './sim.mjs';
const SC = {
  medium:   { duration: 90, rate: 3.0, lanes: 2, yJitter: 30, speed: 240, pStop: 0.006, pBack: 0.006, pDet: 0.9, pDetOccl: 0.6, boxNoise: 5, mergeIou: 0.3, pMerge: 0.03, pFalse: 0.02, fps: 12, sizeVar: 1 },
  dense:    { duration: 90, rate: 6.0, lanes: 4, yJitter: 40, speed: 220, pStop: 0.008, pBack: 0.008, pDet: 0.88, pDetOccl: 0.55, boxNoise: 6, mergeIou: 0.3, pMerge: 0.05, pFalse: 0.03, fps: 12, sizeVar: 1 },
  lowfps:   { duration: 90, rate: 3.0, lanes: 2, yJitter: 30, speed: 300, pStop: 0.006, pBack: 0.006, pDet: 0.88, pDetOccl: 0.55, boxNoise: 6, mergeIou: 0.3, pMerge: 0.03, pFalse: 0.02, fps: 6, sizeVar: 1, fpsVar: 0.5 },
  backforth:{ duration: 90, rate: 2.0, lanes: 2, yJitter: 30, speed: 240, pStop: 0.01, pBack: 0.03, pDet: 0.9, pDetOccl: 0.6, boxNoise: 5, mergeIou: 0.3, pMerge: 0.03, pFalse: 0.02, fps: 10, sizeVar: 1 },
  poordet:  { duration: 90, rate: 3.0, lanes: 2, yJitter: 30, speed: 240, pStop: 0.006, pBack: 0.006, pDet: 0.7, pDetOccl: 0.4, boxNoise: 9, mergeIou: 0.3, pMerge: 0.06, pFalse: 0.06, fps: 10, sizeVar: 1 },
};
const sims = {};
for (const [k, c] of Object.entries(SC)) sims[k] = [1, 2, 3].map((s) => simulate(c, s * 7919));
export function evalCfg(tOpts, cOpts) {
  const row = {}; let tot = 0, totGt = 0, totFlags = 0;
  for (const [k, list] of Object.entries(sims)) {
    let e = 0, gt = 0, fl = 0;
    for (const sim of list) { const r = runEngine(sim, tOpts, cOpts); e += Math.abs(r.auto - sim.gtCount); gt += sim.gtCount; fl += r.flags.length; }
    row[k] = (100 * e / gt).toFixed(2) + '%/' + (100 * fl / gt).toFixed(1);
    tot += e; totGt += gt; totFlags += fl;
  }
  return { row, err: 100 * tot / totGt, flags: 100 * totFlags / totGt };
}
const variants = JSON.parse(process.argv[2] || '[{}]');
for (const v of variants) {
  const r = evalCfg(v.t || {}, v.c || {});
  console.log(JSON.stringify(v).padEnd(60), 'err%', r.err.toFixed(2), 'flags%', r.flags.toFixed(1), JSON.stringify(r.row));
}
