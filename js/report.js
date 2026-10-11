// Report data, CSV/JSON exports and a short text summary for WhatsApp/e-mail.
import { t, fmt, fmtDur, fmtTime, fmtClock, getLang } from './i18n.js';

export function summarize(doc) {
  const c = doc.counts;
  const final = c.auto + c.manual + c.review;
  const pending = doc.flags.filter((f) => f.status === 'pending');
  let lo = 0, hi = 0;
  for (const f of pending) { if (f.suggest > 0) hi += f.suggest; else lo += f.suggest; }
  const dur = (doc.stats.endedAt || Date.now()) - (doc.stats.startedAt || doc.createdAt);
  const activeMin = Math.max(1 / 60, dur / 60000);
  return {
    final, auto: c.auto, fwd: c.fwd, back: c.back, manual: c.manual, review: c.review,
    expected: doc.meta.expected ? Number(doc.meta.expected) : null,
    diff: doc.meta.expected ? final - Number(doc.meta.expected) : null,
    pending: pending.length, range: [final + lo, final + hi],
    dur, rate: final / activeMin,
    batches: doc.batches.map((b) => ({ ...b, total: b.auto + b.manual + b.review })),
    gaps: doc.stats.gaps || [],
  };
}

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

export function toCSV(doc, events) {
  const s = summarize(doc);
  const lines = [];
  const L = (...cells) => lines.push(cells.map(csvCell).join(','));
  L('Hasr count report');
  L('Vessel', doc.meta.vessel); L('Voyage', doc.meta.voyage); L('Location', doc.meta.location); L('Counted by', doc.meta.operator);
  L('Source', doc.source.kind, doc.source.label || '');
  L('Started', doc.stats.startedAt ? new Date(doc.stats.startedAt).toISOString() : '');
  L('Ended', doc.stats.endedAt ? new Date(doc.stats.endedAt).toISOString() : '');
  L('Final count', s.final); L('Automatic count', s.auto); L('Forward crossings', s.fwd); L('Backward crossings (subtracted)', s.back);
  L('Review adjustments', s.review); L('Manual adjustments', s.manual);
  if (s.expected != null) { L('Expected (manifest)', s.expected); L('Difference', s.diff); }
  L('Pending review cases', s.pending);
  L('Model', doc.stats.model, doc.stats.backend);
  L('');
  L('Truck', 'Start', 'End', 'Automatic', 'Review', 'Manual', 'Total');
  for (const b of s.batches) L(b.n, iso(b.start, doc), iso(b.end, doc), b.auto, b.review, b.manual, b.total);
  L('');
  L('Review case', 'Type', 'Time', 'Truck', 'Suggested', 'Status', 'Applied');
  for (const f of doc.flags) L(f.fid, f.type, f.wall ? new Date(f.wall).toISOString() : (f.mt != null ? f.mt.toFixed(2) + 's' : ''), f.b, f.suggest, f.status, f.delta);
  if (events && events.length) {
    L('');
    L('Event', 'Kind', 'Direction', 'Time', 'Video time (s)', 'Truck', 'Track');
    for (const e of events) L(e.seq, e.k === 'x' ? 'crossing' : 'manual', e.dir, e.wall ? new Date(e.wall).toISOString() : '', e.mt ?? '', e.b, e.tr ?? '');
  }
  return '﻿' + lines.join('\r\n');
}

function iso(v, doc) {
  if (v == null) return '';
  return doc.source.kind === 'file' ? '' : new Date(v).toISOString();
}

export function toJSON(doc, events) {
  return JSON.stringify({ app: 'hasr', version: 1, session: doc, events }, null, 1);
}

export function textSummary(doc) {
  const s = summarize(doc);
  const ar = getLang() === 'ar';
  const out = [];
  out.push(`${t('reportTitle')} – ${t('appName')}`);
  if (doc.meta.vessel) out.push(`${t('vessel')}: ${doc.meta.vessel}${doc.meta.voyage ? ' / ' + doc.meta.voyage : ''}`);
  if (doc.meta.location) out.push(`${t('location')}: ${doc.meta.location}`);
  out.push(`${t('finalCount')}: ${fmt(s.final)} ${t('heads')}`);
  if (s.expected != null) out.push(`${t('expected')}: ${fmt(s.expected)} (${t('difference')}: ${s.diff > 0 ? '+' : ''}${fmt(s.diff)})`);
  out.push(`${t('autoCount')}: ${fmt(s.auto)} · ${t('reviewAdj')}: ${s.review >= 0 ? '+' : ''}${s.review} · ${t('manualAdj')}: ${s.manual >= 0 ? '+' : ''}${s.manual}`);
  if (s.batches.length > 1) {
    out.push(`${t('batches')}:`);
    for (const b of s.batches) out.push(`  ${t('batch')} ${b.n}: ${fmt(b.total)}`);
  }
  out.push(`${t('duration')}: ${fmtDur(s.dur)} · ${t('avgRate')}: ${fmt(s.rate)} ${t('perMin')}`);
  if (doc.stats.startedAt) out.push(`${t('started')}: ${fmtTime(doc.stats.startedAt)}`);
  if (s.pending) out.push(`${t('pendingReport')} ${fmt(s.range[0])} – ${fmt(s.range[1])}`);
  void ar;
  return out.join('\n');
}

export function batchTime(b, doc) {
  if (doc.source.kind === 'file') return ['', ''];
  return [b.start ? fmtClock(b.start) : '–', b.end ? fmtClock(b.end) : '–'];
}

export function fileName(doc, ext) {
  const base = (doc.meta.vessel || 'count').replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 40);
  const d = new Date(doc.stats.startedAt || doc.createdAt);
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  return `hasr-${base}-${stamp}.${ext}`;
}
