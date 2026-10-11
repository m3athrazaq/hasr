// A counting session: totals, trucks (batches), review cases and the event log, saved continuously.
import { store } from './store.js';

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export class Session {
  static create({ meta, source, config }) {
    const s = new Session();
    const now = Date.now();
    s.doc = {
      id: uid(), v: 1, createdAt: now, updatedAt: now, status: 'setup',
      meta: { ...meta },
      source: { ...source },
      config: { ...config },
      counts: { auto: 0, fwd: 0, back: 0, manual: 0, review: 0 },
      sign: 1,
      batches: [{ n: 1, start: null, end: null, auto: 0, manual: 0, review: 0 }],
      flags: [],
      stats: { startedAt: null, endedAt: null, activeMs: 0, frames: 0, fpsAvg: 0, gaps: [], model: '', backend: '', device: navigator.userAgent },
      seq: 0,
    };
    return s;
  }

  static async load(id) {
    const doc = await store.getSession(id);
    if (!doc) return null;
    const s = new Session();
    s.doc = doc;
    return s;
  }

  constructor() {
    this.doc = null;
    this._pending = [];
    this._saveTimer = null;
    this.onChange = null;
  }

  get id() { return this.doc.id; }
  get counts() { return this.doc.counts; }
  get batch() { return this.doc.batches[this.doc.batches.length - 1]; }
  get final() { const c = this.doc.counts; return c.auto + c.manual + c.review; }
  get pendingFlags() { return this.doc.flags.filter((f) => f.status === 'pending'); }
  // range the final count may move within if every pending suggestion were accepted or rejected
  get range() {
    let lo = 0, hi = 0;
    for (const f of this.pendingFlags) { if (f.suggest > 0) hi += f.suggest; else lo += f.suggest; }
    return [this.final + lo, this.final + hi];
  }

  begin(now, stats) {
    const d = this.doc;
    d.status = 'active';
    if (!d.stats.startedAt) d.stats.startedAt = now;
    if (!this.batch.start) this.batch.start = now;
    Object.assign(d.stats, stats || {});
    this.save(true);
  }

  // e: counter 'cross' event; when: {wall, mt}
  cross(e, when) {
    const d = this.doc;
    const dir = e.dir * d.sign;
    d.counts.auto += dir;
    if (dir > 0) d.counts.fwd++; else d.counts.back++;
    this.batch.auto += dir;
    d.seq++;
    this._pending.push({ sid: d.id, seq: d.seq, k: 'x', dir, tr: e.track, wall: when.wall, mt: when.mt, b: this.batch.n });
    this.save();
    this.onChange?.('cross', dir);
    return dir;
  }

  flag(f, when, extra = {}) {
    const d = this.doc;
    const rec = {
      id: `${d.id}-${d.flags.length + 1}`, fid: d.flags.length + 1, type: f.type, suggest: f.suggest * d.sign,
      status: 'pending', delta: 0, wall: when.wall, mt: when.mt, b: this.batch.n, clip: false, ...extra,
    };
    d.flags.push(rec);
    this.save();
    this.onChange?.('flag', rec);
    return rec;
  }

  resolve(fid, delta) {
    const d = this.doc;
    const f = d.flags.find((x) => x.fid === fid);
    if (!f) return;
    const old = f.status === 'resolved' ? f.delta : 0;
    f.delta = delta;
    f.status = 'resolved';
    d.counts.review += delta - old;
    const b = d.batches.find((x) => x.n === f.b) || this.batch;
    b.review += delta - old;
    this.save(true);
    this.onChange?.('review', f);
  }

  manual(delta, when) {
    const d = this.doc;
    d.counts.manual += delta;
    this.batch.manual += delta;
    d.seq++;
    this._pending.push({ sid: d.id, seq: d.seq, k: 'm', dir: delta, wall: when.wall, mt: when.mt, b: this.batch.n });
    this.save(true);
    this.onChange?.('manual', delta);
  }

  newBatch(now) {
    const d = this.doc;
    this.batch.end = now;
    d.batches.push({ n: this.batch.n + 1, start: now, end: null, auto: 0, manual: 0, review: 0 });
    this.save(true);
    this.onChange?.('batch');
  }

  // the arrow was drawn the wrong way round: flip every count already made
  flipDirection() {
    const d = this.doc;
    d.sign *= -1;
    d.counts.auto = -d.counts.auto;
    [d.counts.fwd, d.counts.back] = [d.counts.back, d.counts.fwd];
    for (const b of d.batches) b.auto = -b.auto;
    for (const f of d.flags) if (f.status === 'pending') f.suggest = -f.suggest;
    this.save(true);
    this.onChange?.('flip');
  }

  gap(from, to, when) {
    this.doc.stats.gaps.push({ from, to, ms: to - from });
    this.flag({ type: 'camgap', suggest: 0 }, when, { ms: to - from });
  }

  setStats(patch) { Object.assign(this.doc.stats, patch); this.save(); }

  finish(now) {
    const d = this.doc;
    d.status = 'done';
    d.stats.endedAt = now;
    this.batch.end = this.batch.end || now;
    // drop a trailing empty truck created by mistake
    if (d.batches.length > 1) {
      const last = this.batch;
      if (!last.auto && !last.manual && !last.review) { d.batches.pop(); this.batch.end = now; }
    }
    this.save(true);
  }

  save(now = false) {
    this.doc.updatedAt = Date.now();
    if (now) return this.flush();
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => this.flush(), 1500);
  }

  async flush() {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    const ev = this._pending.splice(0);
    await store.putSession(this.doc);
    await store.addEvents(ev);
  }
}
