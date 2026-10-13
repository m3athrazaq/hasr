// Emulates the app's automatic counting line for a recorded video (autoLineFromFile in app.js):
// several short looks at 8 fps, tracker + FlowLearner, stops once one spot is clear.
// usage: node test/autoline.mjs DETS.json DURATION_S   (DETS dumped at >= 8 fps over the whole video)
import fs from 'fs';
import { Tracker } from '../js/engine/tracker.js';
import { FlowLearner } from '../js/engine/flow.js';

const [,, inFile, durStr] = process.argv;
const D = JSON.parse(fs.readFileSync(inFile, 'utf8'));
const dur = Number(durStr);
const nearest = (t) => D.frames.reduce((best, f) => (Math.abs(f.t - t) < Math.abs(best.t - t) ? f : best));
const tracker = new Tracker({ fps: 15 });
const flow = new FlowLearner();
let sug = null, looks = 0;
for (const start of [0.12, 0.35, 0.58, 0.8, 0.95]) {
  tracker.reset();
  const t0 = Math.max(0, Math.min(dur - 5.5, dur * start));
  for (let i = 0; i < 40; i++) {
    const tt = t0 + i / 8;
    if (tt >= dur) break;
    const { tracks } = tracker.step(nearest(tt).boxes, tt);
    flow.add(tracks, D.W, D.H);
  }
  sug = flow.suggest() || sug;
  console.error(`look at ${(t0).toFixed(1)}s: ${sug ? 'line found, n=' + sug.n + ' score=' + sug.score.toFixed(1) : 'not yet'} (tracks seen: ${flow.traj.size})`);
  if (++looks >= 3 && sug && sug.n >= 8) break;
}
if (!sug) { console.log('null'); process.exit(0); }
const L = sug.line;
console.log(JSON.stringify({ line: [L.x1, L.y1, L.x2, L.y2].map((v) => +v.toFixed(4)), dir: sug.dir, n: sug.n }));
