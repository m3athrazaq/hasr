// The processing loop: frame -> detector -> tracker -> counting line -> session, plus a short
// frame history used to build review clips for doubtful cases.
import { Tracker, iou, center } from './engine/tracker.js';
import { LineCounter } from './engine/counter.js';
import { FlowLearner } from './engine/flow.js';
import { nextFrame } from './sources.js';
import { store } from './store.js';
import { roundRect } from './overlay.js';

const SENS = {
  normal: { conf: 0.1, lowThr: 0.12, highThr: 0.42, newThr: 0.5 },
  high: { conf: 0.08, lowThr: 0.1, highThr: 0.32, newThr: 0.4 },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const REVIEW_TYPES = new Set(['merge', 'lowconf', 'appear', 'gap']);

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  return Object.assign(document.createElement('canvas'), { width: w, height: h });
}
async function toJpeg(c, q = 0.72) {
  if (c.convertToBlob) return c.convertToBlob({ type: 'image/jpeg', quality: q });
  return new Promise((res) => c.toBlob(res, 'image/jpeg', q));
}

class FrameRing {
  constructor(seconds = 6, width = 320) { this.sec = seconds; this.w = width; this.items = []; this.pool = []; this.lastT = -1; }
  push(video, vw, vh, t, tracks) {
    if (t - this.lastT < 0.08) return;
    this.lastT = t;
    const h = Math.max(2, Math.round(this.w * vh / vw));
    while (this.items.length && t - this.items[0].t > this.sec) this.pool.push(this.items.shift().c);
    let c = this.pool.pop();
    if (!c) c = makeCanvas(this.w, h);
    if (c.height !== h) c.height = h;
    c.getContext('2d').drawImage(video, 0, 0, this.w, h);
    this.items.push({ t, c, vw, vh, tracks });
  }
  range(t0, t1) { return this.items.filter((it) => it.t >= t0 && it.t <= t1); }
  clear() { for (const it of this.items) this.pool.push(it.c); this.items = []; this.lastT = -1; }
}

export class Pipeline {
  constructor({ source, detector, overlay, session = null, settings, onUpdate, onEvent }) {
    this.source = source;
    this.video = source.video;
    this.detector = detector;
    this.overlay = overlay;
    this.session = session;           // null while previewing during setup
    this.settings = settings;
    this.onUpdate = onUpdate;
    this.onEvent = onEvent;
    this.sens = SENS[settings.sensitivity] || SENS.normal;
    this.tracker = new Tracker({ fps: 15, lowThr: this.sens.lowThr, highThr: this.sens.highThr, newThr: this.sens.newThr });
    this.counter = new LineCounter({ band: settings.band || 0.02 });
    this.ring = new FrameRing(6, 320);
    this.clipReqs = [];
    this.running = false;
    this.paused = false;
    this.lastT = null;
    this.fps = 0;
    this.inferMs = 0;
    this.rate = 1;
    this.quality = 'good';
    this.motion = { votes: 0, n: 0 };
    this.frames = 0;
    this.roi = null;
    this._seen = new Map();
    this.flow = new FlowLearner();
  }

  setGeometry(line, dir, roi) {
    const moved = !this.line || !line || ['x1', 'y1', 'x2', 'y2'].some((k) => Math.abs(this.line[k] - line[k]) > 1e-6);
    if (moved) {
      // motion learnt against the old line says nothing about the new one
      this.motion = { votes: 0, n: 0 };
      for (const [k, v] of this._seen) if (v === 'dir') this._seen.delete(k);
    }
    this.line = line ? { ...line } : null; this.dir = dir; this.roi = roi && roi.w > 0.05 && roi.h > 0.05 ? roi : null;
    if (line) this.counter.setLine(line, dir);
  }

  setDetector(d) { this.detector = d; this._resetTracking(); }

  start() {
    if (this.running) return;
    this.running = true;
    this.paused = false;
    this._loopP = this.source.live ? this._liveLoop() : this._fileLoop();
    return this._loopP;
  }
  pause() { this.paused = true; if (!this.source.live) this.video.pause(); }
  resume() { this.paused = false; this.lastT = null; this._resetTracking(); }
  async stop() {
    this.running = false;
    try { await this._loopP; } catch { /* ignore */ }
  }

  _resetTracking() {
    this.tracker.reset();
    this.counter.restart();
    this.ring.clear();
  }

  when(t) {
    if (this.source.live) return { wall: Math.round(Date.now() - (performance.now() / 1000 - t) * 1000), mt: null };
    return { wall: null, mt: Math.round(t * 1000) / 1000 };
  }

  async _liveLoop() {
    while (this.running) {
      if (this.paused || document.hidden) {
        await sleep(150);
        continue;
      }
      await nextFrame(this.video, 40);
      if (!this.running) break;
      try { await this._process(performance.now() / 1000); } catch (e) { console.error(e); await sleep(200); }
    }
  }

  async _fileLoop() {
    // recorded video: analyse a fixed number of frames per second of video, whatever the device speed.
    // The video is paused while a frame is analysed and fast-forwarded in between.
    const v = this.video;
    const step = 1 / 12;
    let next = 0;
    try { v.playbackRate = 2; } catch { /* ignore */ }
    while (this.running && !v.ended) {
      if (this.paused) { if (!v.paused) v.pause(); await sleep(120); continue; }
      if (v.paused) { try { await v.play(); } catch { /* muted playback is allowed */ } }
      const meta = await nextFrame(v, 400);
      if (!this.running) break;
      const t = meta?.mediaTime ?? v.currentTime;
      // take the frame nearest the 12-per-second schedule (up to ~half a frame early), so a 30 fps
      // video is sampled every 2-3 frames rather than every 3rd
      if (t + 0.017 < next) continue;
      v.pause();
      const t0 = performance.now();
      try { await this._process(t); } catch (e) { console.error(e); }
      this.rate = step / Math.max(0.005, (performance.now() - t0) / 1000);
      next = Math.max(next + step, t + 0.5 * step);
    }
    if (this.running) {
      // flush anything still undecided at the end of the recording
      const evs = this.counter.finish(this.lastT ?? 0);
      this._handle(evs, this.lastT ?? 0);
      await this._drainClips(true);
      this.onEvent?.({ kind: 'ended' });
    }
  }

  async _process(t) {
    const vw = this.source.width, vh = this.source.height;
    if (!vw || !vh) return;
    if (this.lastT != null && this.source.live && t - this.lastT > 1.5) {
      // the camera or the page stalled: sheep may have passed unseen
      const gapMs = (t - this.lastT) * 1000;
      if (this.session) this.session.gap(this.when(this.lastT).wall, this.when(t).wall, this.when(t));
      this.onEvent?.({ kind: 'gap', ms: gapMs });
      this._resetTracking();
    }
    this.counter.setFrame(vw, vh);
    if (this.line) {
      // sheep standing still are expected to walk across the line (the counting direction, or the
      // way they were actually seen walking if that differs): big backward jumps are other animals
      const [fx, fy] = this.counter.forward();
      const md = this.motionDirection();
      const sgn = md && md !== this.dir ? -1 : 1;
      this.tracker.setFlow(sgn * fx, sgn * fy);
    } else this.tracker.setFlow(0, 0);
    const roiPx = this.roi ? { x: Math.round(this.roi.x * vw), y: Math.round(this.roi.y * vh), w: Math.round(this.roi.w * vw), h: Math.round(this.roi.h * vh) } : null;
    const { boxes, ms } = await this.detector.detect(this.video, vw, vh, roiPx, this.sens.conf);
    this.inferMs = this.inferMs ? 0.85 * this.inferMs + 0.15 * ms : ms;
    if (self.__hasrDebug) self.__hasrDebug.push({ t, W: vw, H: vh, boxes: boxes.map((b) => ({ ...b })) }); // test hook
    const { tracks, events } = this.tracker.step(boxes, t);
    const evs = this.line ? this.counter.update(tracks, events, t) : [];
    this.ring.push(this.video, vw, vh, t, tracks.filter((x) => x.updated).map((x) => ({ id: x.id, b: x.box, s: x.state })));
    this.frames++;
    if (this.lastT != null) {
      const dt = Math.max(1e-3, t - this.lastT);
      const inst = this.source.live ? 1 / dt : 1 / Math.max(1e-3, this._wallDt());
      this.fps = this.fps ? 0.9 * this.fps + 0.1 * inst : inst;
    }
    this._lastWall = performance.now();
    this.lastT = t;

    if (this.session) this._handle(evs, t);
    else { this._learnDirection(tracks); this.flow.add(tracks, vw, vh); }
    await this._drainClips(false);
    this._updateQuality(tracks, boxes);

    // overlay state
    const show = [];
    for (const tr of tracks) {
      if (tr.state === 'lost') continue;
      const st = this.counter.st.get(tr.id);
      show.push({ id: tr.id, x1: tr.box.x1, y1: tr.box.y1, x2: tr.box.x2, y2: tr.box.y2, tentative: tr.state === 'tentative', counted: !!(st && st.crossed > 0), flag: this._seen.get(tr.id) === 'flag' });
    }
    this.overlay.setTracks(show);
    this.overlay.draw();
    this.onUpdate?.({ tracks: show, fps: this.fps, inferMs: this.inferMs, quality: this.quality, t, rate: this.rate, visible: show.filter((s) => !s.tentative).length });
  }

  _wallDt() { return this._lastWall ? (performance.now() - this._lastWall) / 1000 : 0.1; }

  _handle(evs, t) {
    const s = this.session;
    for (const e of evs) {
      if (e.kind === 'cross') {
        const dir = s.cross(e, this.when(e.t));
        this.overlay.pulse(dir);
        this.onEvent?.({ kind: 'cross', dir });
        for (const f of e.flags) {
          if (!REVIEW_TYPES.has(f.type)) continue;
          const rec = s.flag(f, this.when(e.t), { ratio: f.ratio });
          this._seen.set(e.track, 'flag');
          this.clipReqs.push({ fid: rec.fid, t: e.t, until: e.t + 1.0, ids: [e.track] });
          this.onEvent?.({ kind: 'flag', flag: rec });
        }
        if (this.settings.clipsAll && dir > 0) this.clipReqs.push({ fid: 'c' + s.doc.seq, t: e.t, until: e.t + 0.15, ids: [e.track], single: true });
      } else if (e.kind === 'flag' && REVIEW_TYPES.has(e.type)) {
        const rec = s.flag(e, this.when(e.t));
        this.clipReqs.push({ fid: rec.fid, t: e.t, until: Math.max(t, e.t + 1.0), ids: e.tracks || [] });
        this.onEvent?.({ kind: 'flag', flag: rec });
      }
    }
  }

  async _drainClips(all) {
    if (!this.clipReqs.length || !this.session) return;
    const now = this.lastT ?? 0;
    const ready = this.clipReqs.filter((r) => all || now >= r.until);
    if (!ready.length) return;
    this.clipReqs = this.clipReqs.filter((r) => !ready.includes(r));
    for (const r of ready) {
      const frames = r.single ? this.ring.range(r.t - 0.1, r.t + 0.15).slice(-1) : this.ring.range(r.t - 1.6, r.t + 1.0);
      if (!frames.length) continue;
      const pick = [];
      const n = r.single ? 1 : Math.min(14, frames.length);
      for (let i = 0; i < n; i++) pick.push(frames[Math.round(i * (frames.length - 1) / Math.max(1, n - 1))]);
      const blobs = [];
      for (const fr of pick) blobs.push(await this._renderClipFrame(fr, r.ids));
      await store.putClip(this.session.id, r.fid, blobs.filter(Boolean));
      if (typeof r.fid === 'number') {
        const f = this.session.doc.flags.find((x) => x.fid === r.fid);
        if (f) { f.clip = true; this.session.save(); this.onEvent?.({ kind: 'clip', fid: r.fid }); }
      }
    }
  }

  async _renderClipFrame(fr, ids) {
    const w = fr.c.width, h = fr.c.height;
    if (!this._clipCanvas) this._clipCanvas = makeCanvas(w, h);
    const c = this._clipCanvas;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const ctx = c.getContext('2d');
    ctx.drawImage(fr.c, 0, 0);
    const sx = w / fr.vw, sy = h / fr.vh;
    if (this.line) {
      ctx.strokeStyle = '#F2C230'; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(this.line.x1 * w, this.line.y1 * h); ctx.lineTo(this.line.x2 * w, this.line.y2 * h); ctx.stroke();
    }
    for (const tr of fr.tracks) {
      const hot = ids.includes(tr.id);
      ctx.strokeStyle = hot ? '#FF9F43' : 'rgba(255,255,255,0.55)';
      ctx.lineWidth = hot ? 2.5 : 1;
      roundRect(ctx, tr.b.x1 * sx, tr.b.y1 * sy, (tr.b.x2 - tr.b.x1) * sx, (tr.b.y2 - tr.b.y1) * sy, 3);
      ctx.stroke();
    }
    return toJpeg(c);
  }

  _updateQuality(tracks, boxes) {
    let crowd = 0;
    const conf = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) if (iou(boxes[i], boxes[j]) > 0.3) { crowd++; break; }
    }
    for (const tr of tracks) if (tr.state === 'confirmed' && tr.updated) conf.push(tr.score);
    const meanConf = conf.length ? conf.reduce((a, b) => a + b, 0) / conf.length : 1;
    const crowdFrac = boxes.length ? crowd / boxes.length : 0;
    this._q = this._q || { conf: 1, crowd: 0 };
    this._q.conf = 0.9 * this._q.conf + 0.1 * meanConf;
    this._q.crowd = 0.9 * this._q.crowd + 0.1 * crowdFrac;
    // a recorded video is analysed frame by frame, so processing speed does not limit accuracy there
    const fps = this.source.live ? (this.fps || 0) : 99;
    if (this.frames < 8) this.quality = 'good';
    else if (fps < 4.5 || this._q.conf < 0.33) this.quality = 'bad';
    else if (fps < 8 || this._q.conf < 0.45 || this._q.crowd > 0.35) this.quality = 'ok';
    else this.quality = 'good';
  }

  // during setup: learn which way the sheep move so the arrow can be set automatically
  _learnDirection(tracks) {
    if (!this.line) return;
    const vw = this.source.width, vh = this.source.height;
    const ux = (this.line.x2 - this.line.x1) * vw, uy = (this.line.y2 - this.line.y1) * vh;
    const L = Math.hypot(ux, uy) || 1;
    const nx = uy / L, ny = -ux / L; // normal for dir = +1
    for (const tr of tracks) {
      if (tr.state !== 'confirmed' || tr.hist.length < 5) continue;
      const a = tr.hist[0], b = tr.hist[tr.hist.length - 1];
      if (b.t - a.t < 0.4) continue;
      const len = Math.max(tr.box.x2 - tr.box.x1, tr.box.y2 - tr.box.y1);
      const proj = ((b.cx - a.cx) * nx + (b.cy - a.cy) * ny) / Math.max(1, len);
      if (Math.abs(proj) < 0.4) continue;
      const key = tr.id;
      if (this._seen.get(key) === 'dir') continue;
      this._seen.set(key, 'dir');
      this.motion.votes += Math.sign(proj);
      this.motion.n++;
    }
  }

  // decided direction (+1/-1) once enough sheep were seen moving, else 0
  motionDirection() {
    const { votes, n } = this.motion;
    if (n < 6) return 0;
    if (Math.abs(votes) / n < 0.6) return 0;
    return votes > 0 ? 1 : -1;
  }
}

// Learns which way the sheep walk and where, so the counting line can be drawn across the flow
// automatically (perpendicular to the motion, through the middle of the path, as wide as the passage).
// Compare models on one still frame: which one sees sheep in this camera angle? Only detections
// near the counting line matter (that is where every head must be seen).
export async function sheepEvidence(detector, source, roi, line) {
  const vw = source.width, vh = source.height;
  const roiPx = roi ? { x: Math.round(roi.x * vw), y: Math.round(roi.y * vh), w: Math.round(roi.w * vw), h: Math.round(roi.h * vh) } : null;
  const { boxes } = await detector.detect(source.video, vw, vh, roiPx, 0.25);
  const reach = 0.28 * Math.min(vw, vh);
  let score = 0, n = 0;
  for (const b of boxes) {
    if (b.score < 0.35) continue;
    if (line) {
      const cx = (b.x1 + b.x2) / 2, cy = (b.y1 + b.y2) / 2;
      if (segDist(cx, cy, line.x1 * vw, line.y1 * vh, line.x2 * vw, line.y2 * vh) > reach + 0.5 * Math.max(b.x2 - b.x1, b.y2 - b.y1)) continue;
    }
    score += b.score; n++;
  }
  return { score, n };
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy || 1;
  const u = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2));
  return Math.hypot(px - (ax + u * dx), py - (ay + u * dy));
}

export { center };
