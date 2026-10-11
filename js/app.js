// Hasr — app controller: screens, setup, counting, review, reports.
import { setLang, t, fmt, fmtDur, fmtTime, fmtClock, getLang, casesText } from './i18n.js';
import { store, loadSettings, saveSettings } from './store.js';
import { openCamera, openScreen, openFile, listCameras, canCaptureScreen } from './sources.js';
import { Detector, MODELS, runtimeInfo } from './detector.js';
import { Overlay } from './overlay.js';
import { Pipeline, sheepEvidence } from './pipeline.js';
import { Session } from './session.js';
import { summarize, toCSV, toJSON, textSummary, batchTime, fileName } from './report.js';
import { renderGuide } from './guide.js';

export const VERSION = '1.0.0';
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settings = loadSettings();
function seek(video, time) {
  return new Promise((resolve) => {
    const done = () => { video.removeEventListener('seeked', done); resolve(); };
    video.addEventListener('seeked', done);
    try { video.currentTime = time; } catch { done(); }
    setTimeout(done, 1500);
  });
}

const S = {
  stack: ['home'],
  source: null, overlay: null, pipeline: null, session: null,
  detectors: {}, modelKey: null, modelAuto: true,
  line: null, dir: 1, roi: null, userFlipped: false,
  meta: null, srcKind: 'camera', file: null, resumeId: null,
  wake: null, audio: null, tick: null, installEvt: null,
  reviewTimers: [], reviewUrls: [], lastBanner: 0, badSince: 0, dirChecked: false,
};

// ---------- navigation ----------
const SCREENS = ['home', 'new', 'live', 'review', 'report', 'history', 'settings', 'guide'];
function show(name, { push = true, overlay = false } = {}) {
  for (const n of SCREENS) {
    const el = $('scr-' + n);
    if (overlay && n === 'live') continue; // keep the camera running underneath
    el.hidden = n !== name;
    el.classList.toggle('overlay-screen', overlay && n === name);
  }
  if (push) S.stack.push(name);
  window.scrollTo(0, 0);
}
function back() {
  S.stack.pop();
  const prev = S.stack[S.stack.length - 1] || 'home';
  if (prev === 'live') { show('live', { push: false }); stopReviewClips(); return; }
  show(prev, { push: false });
  if (prev === 'home') renderHome();
}
for (const b of document.querySelectorAll('[data-back]')) b.addEventListener('click', back);

// ---------- small UI helpers ----------
let toastTimer = null;
function toast(msg, ms = 2600) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}
function sheet(title, body, actions) {
  return new Promise((resolve) => {
    $('sheetTitle').textContent = title;
    const b = $('sheetBody');
    b.innerHTML = '';
    if (typeof body === 'string') { const p = document.createElement('p'); p.textContent = body; b.append(p); } else if (body) b.append(body);
    const a = $('sheetActions');
    a.innerHTML = '';
    for (const [label, value, cls] of actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn ' + (cls || '');
      btn.textContent = label;
      btn.onclick = () => { $('sheet').hidden = true; resolve(value); };
      a.append(btn);
    }
    $('sheet').hidden = false;
    a.lastElementChild?.focus();
  });
}
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k);
  return e;
}
function download(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

// ---------- home ----------
async function renderHome() {
  const list = await store.listSessions();
  const open = list.find((s) => s.status === 'active' || s.status === 'paused');
  const card = $('resumeCard');
  if (open) {
    card.hidden = false;
    S.resumeId = open.id;
    $('resumeVessel').textContent = [open.meta.vessel, open.meta.voyage].filter(Boolean).join(' / ') || '—';
    $('resumeSrc').textContent = open.meta.location || '';
    $('resumeWhen').textContent = fmtTime(open.updatedAt);
    $('resumeCount').textContent = fmt(open.counts.auto + open.counts.manual + open.counts.review);
    $('btnResume').hidden = open.source.kind === 'file';
  } else {
    card.hidden = true;
    S.resumeId = null;
  }
  const ready = navigator.serviceWorker?.controller ? t('offlineReady') : '';
  $('offlineState').textContent = ready;
  const box = $('recentBox');
  box.innerHTML = '';
  const done = list.filter((x) => x.status === 'done').slice(0, 3);
  if (done.length) {
    box.append(el('h3', { text: t('recent') }));
    for (const x of done) {
      const fin = x.counts.auto + x.counts.manual + x.counts.review;
      box.append(el('button', { class: 'hitem', type: 'button', onclick: () => openReport(x) },
        el('div', {}, el('b', { text: [x.meta.vessel, x.meta.voyage].filter(Boolean).join(' / ') || '—' }),
          el('div', { class: 'muted small', text: `${fmtTime(x.stats.startedAt || x.createdAt)}${x.meta.location ? ' · ' + x.meta.location : ''}` })),
        el('span', { class: 'num', text: fmt(fin) })));
    }
  } else {
    box.append(el('h3', { text: t('howTitle') }), el('ol', { class: 'how' }, el('li', { text: t('how1') }), el('li', { text: t('how2') }), el('li', { text: t('how3') })));
  }
}

$('btnNew').onclick = () => openNewForm('camera');
$('btnFile').onclick = () => openNewForm('file');
$('btnHistory').onclick = () => { renderHistory(); show('history'); };
$('btnGuide').onclick = () => { renderGuide($('guideBody')); show('guide'); };
$('btnSettings').onclick = () => { renderSettings(); show('settings'); };
$('btnResume').onclick = () => resumeSession(S.resumeId);
$('btnResumeFinish').onclick = async () => {
  const s = await Session.load(S.resumeId);
  if (!s) return;
  s.finish(Date.now());
  await s.flush();
  openReport(s.doc);
};

// ---------- new session ----------
function openNewForm(kind) {
  const f = $('newForm');
  f.reset();
  const last = settings.lastMeta || {};
  $('fLocation').value = last.location || '';
  $('fOperator').value = last.operator || '';
  $('srcScreenWrap').hidden = !canCaptureScreen();
  for (const r of f.querySelectorAll('input[name=src]')) r.checked = r.value === kind;
  show('new');
  setTimeout(() => $('fVessel').focus(), 50);
}

$('newForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const meta = {
    vessel: $('fVessel').value.trim(), voyage: $('fVoyage').value.trim(), location: $('fLocation').value.trim(),
    operator: $('fOperator').value.trim(), expected: $('fExpected').value ? Math.max(0, Math.round(Number($('fExpected').value))) : null,
  };
  settings.lastMeta = { location: meta.location, operator: meta.operator };
  saveSettings(settings);
  const kind = new FormData(e.target).get('src') || 'camera';
  S.meta = meta;
  S.srcKind = kind;
  S.resumeId = null;
  if (kind === 'file') {
    const inp = $('fileInput');
    inp.value = '';
    inp.onchange = () => { if (inp.files && inp.files[0]) { S.file = inp.files[0]; enterSetup(); } };
    inp.click();
  } else {
    enterSetup();
  }
});

// ---------- live: setup ----------
async function enterSetup(resumeDoc = null) {
  const live = $('scr-live');
  live.dataset.mode = 'setup';
  show('live');
  $('btnLiveBack').hidden = false;
  msg(t('loadingRuntime'));
  const video = $('video');
  if (!S.overlay) {
    S.overlay = new Overlay($('stage'), video, $('overlay'));
    S.overlay.onChange = onGeometryChange;
  }
  S.overlay.editable = true;
  S.overlay.tool = 'line';
  setToolButtons();
  S.overlay.setTracks([]);
  // open the source
  try {
    await closeSource();
    if (S.srcKind === 'camera') S.source = await openCamera(video, { deviceId: settings.lastCamera || undefined });
    else if (S.srcKind === 'screen') S.source = await openScreen(video);
    else S.source = await openFile(video, S.file);
  } catch (err) {
    console.error(err);
    const code = err && err.code;
    msg(code === 'denied' ? t('camDenied') : code === 'none' ? t('camNone') : code === 'screen' ? t('screenNA') : (err.message || String(err)));
    return;
  }
  S.source.onEnded?.(() => { if (S.source?.live) banner(t('sourceEnded'), 'bad'); });
  if (S.source.kind === 'camera') {
    settings.lastCamera = S.source.deviceId || '';
    saveSettings(settings);
    await fillCameraList();
  } else { $('camPick').hidden = true; $('zoomPick').hidden = true; }
  if (S.source.kind === 'file') {
    // show a frame from early in the recording to draw the line on
    await seek(S.source.video, Math.min(5, (S.source.duration || 10) * 0.1));
  }
  // geometry: resume > preset for this source > sensible default
  const key = presetKey();
  const pre = resumeDoc ? resumeDoc.config : settings.presets[key];
  if (pre && pre.line) { S.line = pre.line; S.dir = pre.dir || 1; S.roi = pre.roi || null; S.userFlipped = true; }
  else { S.line = { x1: 0.5, y1: 0.08, x2: 0.5, y2: 0.92 }; S.dir = 1; S.roi = null; S.userFlipped = false; }
  S.overlay.line = S.line; S.overlay.dir = S.dir; S.overlay.roi = S.roi;
  $('btnRoiClear').hidden = !S.roi;
  S.overlay.resize();
  // model
  const view = resumeDoc ? resumeDoc.config.model : settings.view;
  $('selView').value = resumeDoc ? resumeDoc.config.model : settings.view;
  S.modelAuto = view === 'auto';
  const first = S.modelAuto ? 'general-n' : view;
  try {
    await useModel(first);
  } catch (err) {
    console.error(err);
    modelState(t('modelFail'), 'bad');
    msg('');
    return;
  }
  msg('');
  $('btnStart').textContent = resumeDoc ? t('resumeCount') : t('startCount');
  $('btnStart').disabled = false;
  S.resumeDoc = resumeDoc;
  startPreview();
  // first guess with the current line; drawing a new line repeats the choice
  if (S.modelAuto) autoPickModel();
}

function presetKey() {
  return S.srcKind + ':' + (S.srcKind === 'camera' ? (settings.lastCamera || 'default') : S.srcKind === 'file' ? 'file' : 'screen');
}

function msg(text) {
  const m = $('stageMsg');
  m.textContent = text || '';
  m.hidden = !text;
}
function modelState(text, cls = '') {
  const m = $('modelState');
  m.textContent = text;
  m.className = 'model-state ' + cls;
}

async function getDetector(key) {
  if (S.detectors[key]) return S.detectors[key];
  modelState(t('loadingModel'));
  const d = await Detector.create(key, {
    backend: settings.backend,
    onProgress: (p, what) => modelState(`${what === 'runtime' ? t('loadingRuntime') : t('loadingModel')} ${Math.round(p * 100)}%`),
  });
  S.detectors[key] = d;
  return d;
}

async function useModel(key) {
  const d = await getDetector(key);
  S.modelKey = key;
  if (S.pipeline) S.pipeline.setDetector(d);
  const names = { 'sheep-top': t('viewTop'), 'general-n': t('viewSide'), 'general-s': t('viewSideHq') };
  modelState(`${t('modelReady')}: ${names[key]}${S.modelAuto ? ' · ' + t('picked') : ''}`, 'ok');
  return d;
}

async function autoPickModel() {
  // compare the overhead and the angled model on live frames until one clearly sees more sheep
  const runId = (S.autoRun = (S.autoRun || 0) + 1);
  modelState(t('pickingModel'));
  $('btnStart').disabled = true;
  S.picking = true;
  let top, side;
  try { top = await getDetector('sheep-top'); side = await getDetector('general-n'); } catch { $('btnStart').disabled = false; S.picking = false; return; }
  let sTop = 0, sSide = 0, rounds = 0, warned = false;
  while (S.autoRun === runId && $('scr-live').dataset.mode === 'setup' && S.source) {
    const a = await sheepEvidence(top, S.source, S.roi, S.line);
    const b = await sheepEvidence(side, S.source, S.roi, S.line);
    sTop += a.score; sSide += b.score; rounds++;
    const hi = Math.max(sTop, sSide), lo = Math.min(sTop, sSide);
    if (hi >= 2.5 && hi >= 1.5 * lo) break;
    if (rounds >= 4 && hi < 0.8) {
      if (!warned) { modelState(t('noSheepYet')); warned = true; }
      sTop *= 0.5; sSide *= 0.5;
    }
    if (rounds >= 14 && hi >= 1) break;
    await sleep(S.source.live ? 700 : 50);
    if (!S.source.live && S.source.video) {
      // recorded video: look at a few moments of the recording
      await seek(S.source.video, Math.min(S.source.duration - 0.1, (rounds * 0.07 + 0.05) * S.source.duration));
    }
  }
  if (S.autoRun !== runId || $('scr-live').dataset.mode !== 'setup') return;
  // the overhead model must clearly win: it also fires on far-away or partial animals
  const pick = sTop > 1.5 * sSide ? 'sheep-top' : 'general-n';
  await useModel(pick);
  S.picking = false;
  $('btnStart').disabled = false;
  if (S.source && !S.source.live) previewFileFrame();
}

function startPreview() {
  stopPipeline();
  const p = new Pipeline({
    source: S.source, detector: S.detectors[S.modelKey], overlay: S.overlay, session: null, settings,
    onUpdate: (u) => {
      $('setupSeen').textContent = String(u.visible);
      $('setupFps').textContent = u.fps ? u.fps.toFixed(1) : '–';
      setQ($('setupQ'), u.quality);
      if (!S.userFlipped) {
        const md = p.motionDirection();
        if (md && md !== S.dir) { S.dir = md; S.overlay.dir = md; p.setGeometry(S.line, S.dir, S.roi); }
      }
    },
  });
  p.setGeometry(S.line, S.dir, S.roi);
  S.pipeline = p;
  if (S.source.live) p.start();
  else previewFileFrame();
}

async function previewFileFrame() {
  // recorded video: detect on the paused frame so the user sees what the model finds
  const d = S.detectors[S.modelKey];
  if (!d || !S.source) return;
  const v = S.source.video;
  const vw = S.source.width, vh = S.source.height;
  const r = await d.detect(v, vw, vh, null, 0.25);
  S.overlay.setTracks(r.boxes.filter((b) => b.score >= 0.35).map((b, i) => ({ id: i + 1, ...b, tentative: false })));
  S.overlay.draw();
  $('setupSeen').textContent = String(r.boxes.filter((b) => b.score >= 0.35).length);
}

function onGeometryChange() {
  const changed = JSON.stringify(S.line) !== JSON.stringify(S.overlay.line);
  S.line = S.overlay.line;
  S.roi = S.overlay.roi;
  if (changed && !S.userFlipped) { S.dir = 1; S.overlay.dir = 1; S.overlay.draw(); }
  $('btnRoiClear').hidden = !S.roi;
  if (S.pipeline) S.pipeline.setGeometry(S.line, S.dir, S.roi);
  if (S.overlay.tool === 'roi') { S.overlay.tool = 'line'; setToolButtons(); }
  // the best model depends on how the sheep look where they cross the line
  if (S.modelAuto && $('scr-live').dataset.mode === 'setup') autoPickModel();
}

function setToolButtons() {
  $('btnToolLine').setAttribute('aria-pressed', String(S.overlay?.tool === 'line'));
  $('btnToolRoi').setAttribute('aria-pressed', String(S.overlay?.tool === 'roi'));
}
$('btnFlip').onclick = () => {
  S.dir = -S.dir;
  S.userFlipped = true;
  S.overlay.dir = S.dir;
  S.overlay.draw();
  S.pipeline?.setGeometry(S.line, S.dir, S.roi);
};
$('btnToolLine').onclick = () => { S.overlay.tool = 'line'; setToolButtons(); toast(t('step2')); };
$('btnToolRoi').onclick = () => { S.overlay.tool = 'roi'; setToolButtons(); toast(t('roiOn')); };
$('btnRoiClear').onclick = () => { S.overlay.roi = null; onGeometryChange(); S.overlay.draw(); };
$('selView').onchange = async (e) => {
  const v = e.target.value;
  S.modelAuto = v === 'auto';
  if (S.modelAuto) autoPickModel();
  else { S.autoRun = (S.autoRun || 0) + 1; S.picking = false; $('btnStart').disabled = false; try { await useModel(v); } catch { modelState(t('modelFail'), 'bad'); } }
  if (S.source && !S.source.live) previewFileFrame();
};
$('btnLiveBack').onclick = async () => { await leaveLive(); back(); };

async function fillCameraList() {
  const cams = await listCameras();
  const sel = $('selCamera');
  sel.innerHTML = '';
  for (const c of cams) sel.append(el('option', { value: c.id, text: c.label }));
  sel.value = S.source.deviceId || '';
  $('camPick').hidden = cams.length < 2;
  const z = S.source.zoomRange?.();
  $('zoomPick').hidden = !z;
  if (z) { const r = $('rngZoom'); r.min = z.min; r.max = z.max; r.step = z.step; r.value = z.value; r.oninput = () => S.source.setZoom(Number(r.value)); }
}
$('selCamera').onchange = async (e) => {
  settings.lastCamera = e.target.value;
  saveSettings(settings);
  stopPipeline();
  await closeSource();
  try { S.source = await openCamera($('video'), { deviceId: e.target.value }); } catch { msg(t('camNone')); return; }
  S.overlay.resize();
  await fillCameraList();
  startPreview();
};

// ---------- live: counting ----------
$('btnStart').onclick = async () => {
  if (!S.line) { toast(t('drawLineFirst')); return; }
  S.autoRun = (S.autoRun || 0) + 1; // stop automatic model picking
  stopPipeline();
  // remember this placement for next time
  settings.presets[presetKey()] = { line: S.line, dir: S.dir, roi: S.roi };
  saveSettings(settings);
  try { navigator.storage?.persist?.(); } catch { /* ignore */ }
  let session;
  if (S.resumeDoc) {
    session = await Session.load(S.resumeDoc.id);
    session.doc.config = { ...session.doc.config, line: S.line, dir: S.dir, roi: S.roi, model: S.modelKey };
  } else {
    session = Session.create({
      meta: S.meta,
      source: { kind: S.source.kind, label: S.source.label, fileName: S.source.fileName || null },
      config: { model: S.modelKey, line: S.line, dir: S.dir, roi: S.roi, sensitivity: settings.sensitivity, band: settings.band },
    });
  }
  S.session = session;
  session.onChange = onSessionChange;
  const info = runtimeInfo();
  if (S.resumeDoc && S.source.live) {
    // the count was interrupted: sheep may have passed while nothing was watching
    const from = session.doc.updatedAt, to = Date.now();
    if (to - from > 1500) session.gap(from, to, { wall: to, mt: null });
  }
  session.begin(Date.now(), { model: S.modelKey, backend: info.backend + '/' + info.threads });
  if (settings.sound) ensureAudio();
  const live = $('scr-live');
  live.dataset.mode = 'count';
  S.overlay.editable = false;
  S.overlay.tool = 'none';
  $('fileProg').hidden = S.source.live;
  $('btnBatch').hidden = false;
  $('btnPause').textContent = t('pause');
  S.dirChecked = false;
  if (!S.source.live) await seek(S.source.video, 0);
  const p = new Pipeline({
    source: S.source, detector: S.detectors[S.modelKey], overlay: S.overlay, session, settings,
    onUpdate: onLiveUpdate, onEvent: onPipelineEvent,
  });
  p.setGeometry(S.line, S.dir, S.roi);
  S.pipeline = p;
  p.start();
  acquireWake();
  clearInterval(S.tick);
  S.tick = setInterval(tickUI, 500);
  renderCounter();
  tickUI();
};

function onSessionChange(kind, payload) {
  renderCounter(kind === 'cross' && payload > 0);
  if (kind === 'cross' && payload > 0 && settings.sound) beep();
  if (kind === 'cross') checkDirection();
  if (kind === 'flag' || kind === 'review') updateBadge();
}

function renderCounter(bump = false) {
  const s = S.session;
  if (!s) return;
  const n = $('cntFinal');
  n.textContent = fmt(s.final);
  if (bump) { n.classList.add('bump'); clearTimeout(S.bumpT); S.bumpT = setTimeout(() => n.classList.remove('bump'), 260); }
  const [lo, hi] = s.range;
  const r = $('cntRange');
  if (lo !== hi) { r.hidden = false; r.textContent = `${fmt(lo)} – ${fmt(hi)}`; } else r.hidden = true;
  $('batchN').textContent = String(s.batch.n);
  $('batchCount').textContent = fmt(s.batch.auto + s.batch.manual + s.batch.review);
  const exp = s.doc.meta.expected;
  if (exp) {
    $('expBar').hidden = false;
    $('expFill').style.width = Math.min(100, (100 * s.final) / exp) + '%';
    $('expText').textContent = `${t('expectedLeft')}: ${fmt(exp - s.final)} / ${fmt(exp)}`;
  } else $('expBar').hidden = true;
  updateBadge();
}

function updateBadge() {
  const s = S.session;
  if (!s) return;
  const n = s.pendingFlags.length;
  const b = $('reviewBadge');
  b.hidden = !n;
  b.textContent = String(n);
}

function tickUI() {
  const s = S.session;
  if (!s) return;
  const st = s.doc.stats;
  const elapsed = S.source?.live ? Date.now() - st.startedAt : (S.pipeline?.lastT || 0) * 1000;
  $('kTime').textContent = fmtDur(elapsed);
  const mins = Math.max(1 / 60, elapsed / 60000);
  $('kRate').textContent = fmt(s.final / mins);
  const p = S.pipeline;
  $('kFps').textContent = p && p.fps ? p.fps.toFixed(1) : '–';
  setQ($('kQ'), p?.quality || 'good');
  if (p?.quality === 'bad' && S.source?.live) {
    S.badSince = S.badSince || Date.now();
    if (Date.now() - S.badSince > 6000 && Date.now() - S.lastBanner > 30000) { banner(t('qBadHint'), 'warn'); S.lastBanner = Date.now(); }
  } else S.badSince = 0;
  if (!S.source?.live && S.source?.duration) {
    const v = S.source.video;
    const pct = Math.min(100, (100 * v.currentTime) / S.source.duration);
    $('fileFill').style.width = pct + '%';
    $('fileText').textContent = `${t('fileProgress')} ${Math.round(pct)}% · ${fmtDur(v.currentTime * 1000)} / ${fmtDur(S.source.duration * 1000)} · ×${(p?.rate || 1).toFixed(2)}`;
  }
  if (p && s.doc.stats.frames !== p.frames && p.frames % 20 === 0) s.setStats({ frames: p.frames, fpsAvg: Math.round(p.fps * 10) / 10 });
}

function setQ(elx, q) {
  elx.className = 'q ' + q;
  elx.textContent = q === 'good' ? t('qGood') : q === 'ok' ? t('qOk') : t('qBad');
}

function onLiveUpdate() { /* overlay is drawn by the pipeline; KPIs refresh on the timer */ }

function onPipelineEvent(e) {
  if (e.kind === 'gap' && S.session) banner(`${t('gapWarn')} ${fmtDur(e.ms)} – ${t('backgroundWarn')}`, 'warn');
  if (e.kind === 'ended') { toast(t('fileDone')); finishCount(true); }
}

// if most crossings go "backwards", the arrow was drawn the wrong way
function checkDirection() {
  const c = S.session.counts;
  if (S.dirChecked || c.fwd + c.back < 12) return;
  S.dirChecked = true;
  if (c.back >= 0.75 * (c.fwd + c.back)) {
    const b = banner(t('flip') + '?', 'warn', [[t('flip'), () => { S.session.flipDirection(); S.overlay.dir = -S.overlay.dir; renderCounter(); }]]);
    void b;
  }
}

function banner(text, cls = '', actions = []) {
  const b = $('banner');
  b.className = 'banner ' + cls;
  b.innerHTML = '';
  b.append(el('span', { text }));
  const row = el('div', { class: 'row gap' });
  for (const [label, fn] of actions) row.append(el('button', { class: 'btn small primary', type: 'button', text: label, onclick: () => { fn(); b.hidden = true; } }));
  row.append(el('button', { class: 'btn small ghost', type: 'button', text: '✕', 'aria-label': t('close'), onclick: () => { b.hidden = true; } }));
  b.append(row);
  b.hidden = false;
  clearTimeout(S.bannerT);
  if (!actions.length) S.bannerT = setTimeout(() => { b.hidden = true; }, 12000);
  return b;
}

$('btnBatch').onclick = () => { if (!S.session) return; S.session.newBatch(S.source.live ? Date.now() : null); renderCounter(); toast(`${t('batch')} ${S.session.batch.n}`); };
$('btnPlus').onclick = () => { if (!S.session) return; S.session.manual(1, S.pipeline.when(S.pipeline.lastT ?? 0)); };
$('btnMinus').onclick = () => { if (!S.session) return; S.session.manual(-1, S.pipeline.when(S.pipeline.lastT ?? 0)); };
$('btnPause').onclick = () => {
  const p = S.pipeline;
  if (!p) return;
  if (p.paused) { p.resume(); S.session.doc.status = 'active'; $('btnPause').textContent = t('pause'); msg(''); acquireWake(); }
  else { p.pause(); S.session.doc.status = 'paused'; $('btnPause').textContent = t('resumeCount'); msg(t('paused')); }
  S.session.save(true);
};
$('btnReview').onclick = () => { if (S.session) openReview(S.session); };
$('btnFinish').onclick = async () => {
  const pend = S.session ? S.session.pendingFlags.length : 0;
  const body = t('finishBody') + (pend ? ` ${casesText(pend)} ${t('pendingNote')}.` : '');
  const ok = await sheet(t('finishConfirm'), body, [[t('cancel'), false], [t('finish'), true, 'danger']]);
  if (ok) finishCount(false);
};

async function finishCount() {
  const s = S.session;
  if (!s) return;
  const p = S.pipeline;
  if (p) {
    if (S.source?.live) { const evs = p.counter.finish(p.lastT ?? 0); p._handle(evs, p.lastT ?? 0); await p._drainClips(true); }
    await p.stop();
  }
  S.pipeline = null;
  clearInterval(S.tick);
  s.setStats({ frames: p?.frames || 0, fpsAvg: p ? Math.round(p.fps * 10) / 10 : 0 });
  s.finish(S.source?.live ? Date.now() : (s.doc.stats.startedAt || Date.now()) + Math.round((p?.lastT || 0) * 1000));
  await s.flush();
  releaseWake();
  await closeSource();
  S.session = null;
  $('banner').hidden = true;
  S.stack = ['home'];
  openReport(s.doc);
}

async function resumeSession(id) {
  const s = await Session.load(id);
  if (!s) return;
  S.meta = s.doc.meta;
  S.srcKind = s.doc.source.kind;
  if (S.srcKind === 'file') return;
  await enterSetup(s.doc);
}

async function leaveLive() {
  S.autoRun = (S.autoRun || 0) + 1;
  stopPipeline();
  await closeSource();
  releaseWake();
  $('banner').hidden = true;
}
function stopPipeline() { if (S.pipeline) { S.pipeline.stop(); S.pipeline = null; } }
async function closeSource() { if (S.source) { try { S.source.stop(); } catch { /* ignore */ } S.source = null; } }

// ---------- wake lock, sound ----------
async function acquireWake() {
  try { if ('wakeLock' in navigator && !S.wake) { S.wake = await navigator.wakeLock.request('screen'); S.wake.addEventListener('release', () => { S.wake = null; }); } } catch { /* not granted */ }
}
function releaseWake() { try { S.wake?.release(); } catch { /* ignore */ } S.wake = null; }
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.session && !S.pipeline?.paused) acquireWake(); });
window.addEventListener('beforeunload', (e) => { if (S.session) { S.session.flush(); e.preventDefault(); e.returnValue = ''; } });

function ensureAudio() {
  try { if (!S.audio) S.audio = new (window.AudioContext || window.webkitAudioContext)(); if (S.audio.state === 'suspended') S.audio.resume(); } catch { /* no audio */ }
}
function beep() {
  const a = S.audio;
  if (!a) return;
  const o = a.createOscillator(), g = a.createGain();
  o.frequency.value = 1320; o.type = 'sine';
  g.gain.setValueAtTime(0.0001, a.currentTime);
  g.gain.exponentialRampToValueAtTime(0.18, a.currentTime + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + 0.07);
  o.connect(g).connect(a.destination);
  o.start(); o.stop(a.currentTime + 0.08);
}

// ---------- review ----------
const FLAG_TEXT = {
  merge: ['fMerge', 'fMergeBody'], appear: ['fAppear', 'fAppearBody'], gap: ['fGap', 'fGapBody'], lowconf: ['fLow', 'fLowBody'],
  camgap: ['gapWarn', 'backgroundWarn'],
};

function stopReviewClips() {
  for (const tm of S.reviewTimers) clearInterval(tm);
  for (const u of S.reviewUrls) URL.revokeObjectURL(u);
  S.reviewTimers = []; S.reviewUrls = [];
}

async function openReview(session, fromReport = false) {
  stopReviewClips();
  S.reviewSession = session;
  const live = !!S.pipeline && !fromReport;
  show('review', { overlay: live });
  renderReview(session);
}

function renderReview(session) {
  stopReviewClips();
  const list = $('reviewList');
  list.innerHTML = '';
  const flags = session.doc.flags.slice().sort((a, b) => (a.status === b.status ? b.fid - a.fid : a.status === 'pending' ? -1 : 1));
  $('reviewBulk').hidden = !session.pendingFlags.length;
  if (!flags.length) { list.append(el('p', { class: 'muted', text: t('noFlags') })); return; }
  for (const f of flags) list.append(reviewCard(session, f));
}

function reviewCard(session, f) {
  const [titleK, bodyK] = FLAG_TEXT[f.type] || ['review', 'reviewHint'];
  const img = el('img', { class: 'rclip', alt: '' });
  const when = f.wall ? fmtClock(f.wall) : f.mt != null ? fmtDur(f.mt * 1000) : '';
  const title = f.type === 'camgap' ? `${t('gapWarn')} ${fmtDur(f.ms || 0)}` : t(titleK);
  const sugg = f.suggest ? el('span', { class: 'sugg' }, `${t('suggest')}: `, el('b', { class: 'num', text: `${f.suggest > 0 ? '+' : ''}${f.suggest}` })) : null;
  const actions = el('div', { class: 'ractions' });
  const opts = [[t('keep'), 0], [t('add1'), 1], [t('sub1'), -1]];
  if (f.type === 'merge') opts.push([t('add2'), 2]);
  for (const [label, delta] of opts) {
    const sel = f.status === 'resolved' && f.delta === delta;
    actions.append(el('button', {
      class: 'btn' + (sel ? ' sel' : '') + (delta ? ' num' : ''), type: 'button', text: label,
      onclick: () => { session.resolve(f.fid, delta); renderReview(session); if (S.session === session) renderCounter(); },
    }));
  }
  const card = el('article', { class: 'rcard' + (f.status === 'resolved' ? ' done' : '') },
    f.type === 'camgap' ? el('div', { class: 'rclip' }) : img,
    el('div', { class: 'rbody' },
      el('div', { class: 'rtype', text: title }),
      el('div', { class: 'rmeta' }, `${when} · ${t('batch')} ${f.b}`, f.status === 'resolved' ? ` · ${t('applied')} ` : null, f.status === 'resolved' ? el('b', { class: 'num', text: (f.delta > 0 ? '+' : '') + f.delta }) : null),
      el('div', { class: 'small muted', text: t(bodyK) }),
      sugg, actions));
  if (f.type !== 'camgap') loadClip(session.id, f.fid, img);
  return card;
}

async function loadClip(sid, fid, img) {
  const rec = await store.getClip(sid, fid);
  if (!rec || !rec.frames || !rec.frames.length) return;
  const urls = rec.frames.map((b) => URL.createObjectURL(b));
  S.reviewUrls.push(...urls);
  let i = 0;
  img.src = urls[0];
  if (urls.length > 1) S.reviewTimers.push(setInterval(() => { i = (i + 1) % (urls.length + 4); img.src = urls[Math.min(i, urls.length - 1)]; }, 140));
}

$('btnAcceptAll').onclick = () => {
  const s = currentReviewSession();
  if (!s) return;
  for (const f of s.pendingFlags) s.resolve(f.fid, f.suggest);
  renderReview(s);
  if (S.session === s) renderCounter();
};
$('btnKeepAll').onclick = () => {
  const s = currentReviewSession();
  if (!s) return;
  for (const f of s.pendingFlags) s.resolve(f.fid, 0);
  renderReview(s);
  if (S.session === s) renderCounter();
};
function currentReviewSession() { return S.reviewSession || S.session; }
let hadController = !!navigator.serviceWorker?.controller;

// ---------- report ----------
async function openReport(doc) {
  show('report');
  const s = new Session();
  s.doc = doc;
  S.reviewSession = s;
  s.onChange = () => renderReport(s);
  await renderReport(s);
}

async function renderReport(session) {
  const doc = session.doc;
  const R = summarize(doc);
  const body = $('reportBody');
  body.innerHTML = '';
  const title = [doc.meta.vessel, doc.meta.voyage].filter(Boolean).join(' / ');
  body.append(el('div', { class: 'rep-hero' },
    el('div', {},
      el('div', { class: 'muted', text: t('finalCount') }),
      el('div', { class: 'rep-final num', text: fmt(R.final) })),
    el('div', { class: 'rep-meta' },
      el('b', { text: title || '—' }),
      doc.meta.location ? el('span', { text: doc.meta.location }) : null,
      el('span', { text: `${t('started')}: ${fmtTime(doc.stats.startedAt)}` }),
      doc.source.kind === 'file' ? el('span', { text: doc.source.fileName || '' }) : null)));
  if (R.pending) {
    body.append(el('div', { class: 'notice' },
      el('span', { text: `${casesText(R.pending)} ${t('pendingNote')}. ${t('pendingReport')} ` }),
      el('b', { class: 'num', text: `${fmt(R.range[0])} – ${fmt(R.range[1])}` }), ' ',
      el('button', { class: 'btn small primary', type: 'button', text: t('review'), onclick: () => openReview(session, true) })));
  }
  const figs = el('div', { class: 'figs' });
  const fig = (label, value, cls = '', unit = '') => figs.append(el('div', { class: 'fig ' + cls }, el('span', { class: 'muted small', text: label }), el('div', {}, el('b', { class: 'num', text: value }), unit ? el('span', { class: 'muted small', text: ' ' + unit }) : null)));
  fig(t('autoCount'), fmt(R.auto));
  fig(t('backwards'), fmt(R.back));
  fig(t('reviewAdj'), (R.review > 0 ? '+' : '') + R.review);
  fig(t('manualAdj'), (R.manual > 0 ? '+' : '') + R.manual);
  if (R.expected != null) fig(t('expectedDiff'), (R.diff > 0 ? '+' : '') + fmt(R.diff), R.diff === 0 ? 'ok' : 'warn');
  fig(t('duration'), fmtDur(R.dur));
  fig(t('avgRate'), fmt(R.rate), '', t('perMin'));
  body.append(figs);
  // trucks
  body.append(el('h3', { class: 'section-title', text: t('batches') }));
  const tb = el('tbody');
  for (const b of R.batches) {
    const [from, to] = batchTime(b, doc);
    tb.append(el('tr', {}, el('td', { class: 'num', text: String(b.n) }), el('td', { class: 'num', text: from }), el('td', { class: 'num', text: to }),
      el('td', { class: 'n num', text: fmt(b.auto) }), el('td', { class: 'n num', text: (b.review > 0 ? '+' : '') + b.review }), el('td', { class: 'n num', text: (b.manual > 0 ? '+' : '') + b.manual }), el('td', { class: 'n num', text: fmt(b.total) })));
  }
  const table = el('table', {},
    el('thead', {}, el('tr', {}, el('th', { text: t('batch') }), el('th', { text: t('from') }), el('th', { text: t('to') }), el('th', { class: 'n', text: t('autoCount') }), el('th', { class: 'n', text: t('review') }), el('th', { class: 'n', text: t('manualAdj') }), el('th', { class: 'n', text: t('count') }))),
    tb,
    el('tfoot', {}, el('tr', {}, el('td', { text: t('total') }), el('td', {}), el('td', {}), el('td', { class: 'n num', text: fmt(R.auto) }), el('td', { class: 'n num', text: String(R.review) }), el('td', { class: 'n num', text: String(R.manual) }), el('td', { class: 'n num', text: fmt(R.final) }))));
  body.append(el('div', { class: 'table-wrap' }, table));
  // exports
  const events = await store.getEvents(doc.id);
  const ex = el('div', { class: 'exports' });
  ex.append(el('button', { class: 'btn', type: 'button', text: t('exportCsv'), onclick: () => download(fileName(doc, 'csv'), toCSV(doc, events), 'text/csv;charset=utf-8') }));
  ex.append(el('button', { class: 'btn', type: 'button', text: t('exportJson'), onclick: () => download(fileName(doc, 'json'), toJSON(doc, events), 'application/json') }));
  ex.append(el('button', {
    class: 'btn', type: 'button', text: t('copySummary'),
    onclick: async () => { try { await navigator.clipboard.writeText(textSummary(doc)); toast(t('copied')); } catch { sheet(t('copySummary'), el('textarea', { rows: 10, style: 'width:100%', text: textSummary(doc) }), [[t('close'), true]]); } },
  }));
  if (navigator.share) {
    ex.append(el('button', {
      class: 'btn primary', type: 'button', text: t('share'),
      onclick: async () => {
        const file = new File([toCSV(doc, events)], fileName(doc, 'csv'), { type: 'text/csv' });
        try {
          if (navigator.canShare?.({ files: [file] })) await navigator.share({ title: t('reportTitle'), text: textSummary(doc), files: [file] });
          else await navigator.share({ title: t('reportTitle'), text: textSummary(doc) });
        } catch { /* cancelled */ }
      },
    }));
  }
  body.append(el('h3', { class: 'section-title', text: t('share') }), ex);
  // reconcile
  body.append(el('h3', { class: 'section-title', text: t('compare') }),
    el('p', { class: 'muted small', text: t('compareHint') }),
    el('button', { class: 'btn', type: 'button', text: t('compare'), onclick: () => compareWith(doc) }));
  // technical
  const tech = [`${t('model')}: ${doc.stats.model || '–'}`, doc.stats.backend, doc.source.live !== false && doc.source.kind !== 'file' && doc.stats.fpsAvg ? `${t('fps')}: ${doc.stats.fpsAvg}` : '', doc.stats.gaps?.length ? `${t('gapWarn')}: ${doc.stats.gaps.length}` : ''].filter(Boolean);
  body.append(el('p', { class: 'muted small', text: tech.join(' · ') }));
  body.append(el('button', {
    class: 'btn danger small', type: 'button', text: t('deleteSession'),
    onclick: async () => {
      const ok = await sheet(t('deleteConfirm'), '', [[t('cancel'), false], [t('delete'), true, 'danger']]);
      if (ok) { await store.deleteSession(doc.id); S.stack = ['home']; show('home', { push: false }); renderHome(); }
    },
  }));
}

async function compareWith(doc) {
  const list = (await store.listSessions()).filter((s) => s.id !== doc.id && s.status === 'done');
  const box = el('div', { class: 'compare-list' });
  if (!list.length) box.append(el('p', { class: 'muted', text: t('historyEmpty') }));
  const pick = await new Promise((resolve) => {
    for (const s of list) {
      const fin = s.counts.auto + s.counts.manual + s.counts.review;
      box.append(el('button', { class: 'hitem', type: 'button', onclick: () => { $('sheet').hidden = true; resolve(s); } },
        el('div', {}, el('b', { text: [s.meta.vessel, s.meta.voyage].filter(Boolean).join(' / ') || '—' }), el('div', { class: 'muted small', text: `${fmtTime(s.stats.startedAt)} · ${s.source.kind === 'file' ? s.source.fileName || t('srcFile') : t('srcCamera')}` })),
        el('span', { class: 'num', text: fmt(fin) })));
    }
    sheet(t('compare'), box, [[t('close'), null]]).then(resolve);
  });
  if (!pick) return;
  const A = summarize(doc), B = summarize(pick);
  const diff = A.final - B.final;
  const tbl = el('table', {}, el('thead', {}, el('tr', {}, el('th', { text: t('batch') }), el('th', { class: 'n', text: '1' }), el('th', { class: 'n', text: '2' }), el('th', { class: 'n', text: t('difference') }))));
  const tb = el('tbody');
  const n = Math.max(A.batches.length, B.batches.length);
  if (A.batches.length === B.batches.length && n > 1) {
    for (let i = 0; i < n; i++) {
      const a = A.batches[i].total, b = B.batches[i].total;
      tb.append(el('tr', {}, el('td', { class: 'num', text: String(i + 1) }), el('td', { class: 'n num', text: fmt(a) }), el('td', { class: 'n num', text: fmt(b) }), el('td', { class: 'n num', text: a === b ? '✓' : (a - b > 0 ? '+' : '') + (a - b) })));
    }
  }
  tb.append(el('tr', {}, el('td', { text: t('count') }), el('td', { class: 'n num', text: fmt(A.final) }), el('td', { class: 'n num', text: fmt(B.final) }), el('td', { class: 'n num', text: diff === 0 ? t('match') : (diff > 0 ? '+' : '') + diff })));
  tbl.append(tb);
  await sheet(t('compare'), el('div', { class: 'table-wrap' }, tbl), [[t('close'), true]]);
}

// ---------- history ----------
async function renderHistory() {
  const list = await store.listSessions();
  const box = $('historyList');
  box.innerHTML = '';
  if (!list.length) { box.append(el('p', { class: 'muted', text: t('historyEmpty') })); return; }
  for (const s of list) {
    const fin = s.counts.auto + s.counts.manual + s.counts.review;
    const active = s.status === 'active' || s.status === 'paused';
    box.append(el('button', {
      class: 'hitem', type: 'button',
      onclick: () => (active && s.source.kind !== 'file' ? resumeSession(s.id) : openReport(s)),
    },
    el('div', {},
      el('b', { text: [s.meta.vessel, s.meta.voyage].filter(Boolean).join(' / ') || '—' }), ' ',
      active ? el('span', { class: 'status-pill active', text: t('resumeTitle') }) : null,
      el('div', { class: 'muted small', text: `${fmtTime(s.stats.startedAt || s.createdAt)} · ${s.meta.location || ''}` })),
    el('span', { class: 'num', text: fmt(fin) })));
  }
}

// ---------- settings ----------
function renderSettings() {
  $('sLang').value = settings.lang;
  $('sView').value = settings.view;
  $('sBackend').value = settings.backend;
  $('sSens').value = settings.sensitivity;
  $('sBand').value = settings.band;
  $('sBandOut').textContent = Math.round(settings.band * 1000) / 10 + '%';
  $('sSound').checked = !!settings.sound;
  $('sClips').checked = !!settings.clipsAll;
  $('appVersion').textContent = VERSION;
  const info = runtimeInfo();
  $('runtimeUsed').textContent = info.backend ? `${info.backend} · ${info.threads}` : '–';
  store.usage().then((u) => { $('storageUsed').textContent = u ? (u / 1048576).toFixed(1) + ' MB' : '–'; });
}
$('setForm').addEventListener('input', () => {
  settings.lang = $('sLang').value;
  settings.view = $('sView').value;
  settings.backend = $('sBackend').value;
  settings.sensitivity = $('sSens').value;
  settings.band = Number($('sBand').value);
  settings.sound = $('sSound').checked;
  settings.clipsAll = $('sClips').checked;
  $('sBandOut').textContent = Math.round(settings.band * 1000) / 10 + '%';
  saveSettings(settings);
  setLang(settings.lang);
  if (settings.sound) ensureAudio();
});
$('setForm').addEventListener('submit', (e) => e.preventDefault());

// ---------- install / service worker ----------
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installEvt = e; $('btnInstall').hidden = false; });
$('btnInstall').onclick = async () => { if (!S.installEvt) return; S.installEvt.prompt(); try { await S.installEvt.userChoice; } catch { /* ignore */ } S.installEvt = null; $('btnInstall').hidden = true; };

async function registerSW() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  try {
    await navigator.serviceWorker.register('sw.js');
    // the worker adds the isolation headers that let the AI engine use every CPU core; they apply after one reload
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) toast(t('updateReady'), 5000); hadController = true; });
    if (!self.crossOriginIsolated && !sessionStorage.getItem('hasr.coi')) {
      const reload = () => { if (S.session || S.pipeline) return; sessionStorage.setItem('hasr.coi', '1'); location.reload(); };
      if (navigator.serviceWorker.controller) reload();
      else navigator.serviceWorker.addEventListener('controllerchange', reload, { once: true });
    }
  } catch (e) { console.warn('sw', e); }
}

// ---------- boot ----------
setLang(settings.lang);
window.__hasr = S; // for diagnostics from the browser console
renderHome();
registerSW();
