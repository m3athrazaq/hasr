// Run tracker + counter over dumped detections; write per-frame tracks and events for rendering.
import fs from 'fs';
import { Tracker } from '../js/engine/tracker.js';
import { LineCounter } from '../js/engine/counter.js';
const [,, inFile, outFile, lineStr, dirStr, optsStr] = process.argv;
const D = JSON.parse(fs.readFileSync(inFile, 'utf8'));
const [x1, y1, x2, y2] = lineStr.split(',').map(Number);
const opts = optsStr ? JSON.parse(optsStr) : {};
const tracker = new Tracker({ fps: 15, ...(opts.t || {}) });
const counter = new LineCounter(opts.c || {});
counter.setFrame(D.W, D.H);
counter.setLine({ x1, y1, x2, y2 }, Number(dirStr || 1));
const frames = [], events = [];
for (const f of D.frames) {
  const { tracks, events: tev } = tracker.step(f.boxes, f.t);
  const ev = counter.update(tracks, tev, f.t);
  events.push(...ev.map((e) => ({ ...e, frame: f.i })));
  frames.push({ i: f.i, t: f.t, auto: counter.auto, tracks: tracks.filter((t) => t.state !== 'tentative').map((t) => ({ id: t.id, s: t.state[0], b: [t.box.x1, t.box.y1, t.box.x2, t.box.y2].map((v) => Math.round(v)), u: t.updated })) });
}
const end = D.frames.length ? D.frames[D.frames.length - 1].t : 0;
events.push(...counter.finish(end + 5).map((e) => ({ ...e, frame: -1 })));
fs.writeFileSync(outFile, JSON.stringify({ line: { x1, y1, x2, y2 }, dir: Number(dirStr || 1), frames, events, W: D.W, H: D.H }));
const flags = events.filter((e) => e.kind === 'flag').map((e) => e.type).concat(events.filter((e) => e.kind === 'cross').flatMap((e) => e.flags.map((f) => f.type)));
console.log(`auto=${counter.auto} fwd=${counter.fwd} back=${counter.back} flags=${JSON.stringify(flags.reduce((a, k) => (a[k] = (a[k] || 0) + 1, a), {}))} sheepLen=${counter.sheepLen().toFixed(0)}`);
