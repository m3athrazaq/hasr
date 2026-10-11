// Sheep detector: loads ONNX Runtime Web (WebGPU when available, otherwise multi-threaded WASM),
// runs a YOLO model on a region of the current frame and returns boxes in frame pixels.

export const MODELS = {
  'sheep-top': { file: 'models/sheep-top.onnx', kind: 'v8', size: 640, mb: 12, view: 'top' },
  'general-n': { file: 'models/general-n.onnx', kind: 'e2e', size: 640, mb: 10, view: 'side' },
  'general-s': { file: 'models/general-s.onnx', kind: 'e2e', size: 640, mb: 38, view: 'side' },
};

// COCO classes accepted from the general models (sheep first; other animals cover odd poses)
const COCO_SHEEP = 18;
const COCO_ANIMALS = new Set([14, 15, 16, 17, 18, 19, 21]);

let ortPromise = null;
let backendUsed = null;
let lock = Promise.resolve();

const withTimeout = (p, ms) => Promise.race([p, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);
const TRIAL_KEY = 'hasr.gpuTrial';
const trial = {
  get() { try { return localStorage.getItem(TRIAL_KEY); } catch { return null; } },
  set(v) { try { localStorage.setItem(TRIAL_KEY, v); } catch { /* storage may be unavailable */ } },
};

async function gpuUsable() {
  try {
    if (!('gpu' in navigator)) return false;
    // a previous start on the graphics card never finished (hang or crash): stay on the processor
    if (trial.get() === 'pending' || trial.get() === 'slow') return false;
    const adapter = await withTimeout(navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }), 4000);
    if (!adapter) return false;
    // a software (fallback) adapter is far slower than WASM on the CPU
    if (adapter.isFallbackAdapter || adapter.info?.isFallbackAdapter) return false;
    const vendor = (adapter.info?.vendor || '') + ' ' + (adapter.info?.architecture || '') + ' ' + (adapter.info?.description || '');
    if (/swiftshader|llvmpipe|software/i.test(vendor)) return false;
    return true;
  } catch {
    return false;
  }
}

// Large files are stored in parts (files.json) so the app can also be uploaded through the GitHub web page.
let partsP = null;
function partsManifest() {
  if (!partsP) partsP = fetch(new URL('../files.json', import.meta.url).href).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  return partsP;
}
export async function fetchAsset(path, onProgress) {
  const man = await partsManifest();
  const entry = man[path];
  const urls = entry ? entry.parts : [path];
  const total = entry ? entry.size : 0;
  const chunks = [];
  let got = 0;
  for (const u of urls) {
    const res = await fetch(new URL('../' + u, import.meta.url).href);
    if (!res.ok) throw new Error(`${u}: HTTP ${res.status}`);
    const len = total || Number(res.headers.get('content-length')) || 0;
    if (!res.body || !onProgress) { const b = new Uint8Array(await res.arrayBuffer()); chunks.push(b); got += b.length; continue; }
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      onProgress(len ? Math.min(1, got / len) : 0, got);
    }
  }
  if (chunks.length === 1) return chunks[0];
  const buf = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.length; }
  return buf;
}

export async function loadRuntime(pref = 'auto', onProgress) {
  if (ortPromise) return ortPromise;
  ortPromise = (async () => {
    const useGpu = pref === 'webgpu' || (pref === 'auto' && (await gpuUsable()));
    const ort = await import(useGpu ? '../vendor/ort/ort.webgpu.bundle.min.mjs' : '../vendor/ort/ort.wasm.bundle.min.mjs');
    ort.env.wasm.wasmBinary = await fetchAsset(useGpu ? 'vendor/ort/ort-wasm-simd-threaded.asyncify.wasm' : 'vendor/ort/ort-wasm-simd-threaded.wasm', onProgress);
    const cores = navigator.hardwareConcurrency || 2;
    const wanted = self.crossOriginIsolated ? Math.max(1, Math.min(4, cores - 1)) : 1;
    // on the graphics card the CPU threads only add contention; on the processor use several cores
    ort.env.wasm.numThreads = self.__ortThreads ?? (useGpu ? 1 : wanted);
    // on the processor, run the engine in its own worker so the screen stays responsive
    if (!useGpu && self.__ortProxy !== false) ort.env.wasm.proxy = true;
    ort.env.logLevel = 'error';
    backendUsed = useGpu ? 'webgpu' : 'wasm';
    return ort;
  })();
  ortPromise.catch(() => { ortPromise = null; });
  return ortPromise;
}

export function runtimeInfo() {
  return { backend: backendUsed, threads: self.crossOriginIsolated ? 'multi' : 'single' };
}

export class Detector {
  static async create(key, { backend = 'auto', onProgress } = {}) {
    const info = MODELS[key];
    if (!info) throw new Error('unknown model ' + key);
    const ort = await loadRuntime(backend, onProgress ? (p) => onProgress(p, 'runtime') : null);
    const bytes = await fetchAsset(info.file, onProgress ? (p) => onProgress(p, 'model') : null);
    const eps = backendUsed === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'];
    if (backendUsed === 'webgpu') trial.set('pending');
    let session;
    try {
      session = await ort.InferenceSession.create(bytes, { executionProviders: eps, graphOptimizationLevel: 'all' });
    } catch (e) {
      if (eps[0] !== 'webgpu') throw e;
      session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
      backendUsed = 'wasm';
    }
    const d = new Detector();
    d.key = key;
    d.info = info;
    d.ort = ort;
    d.session = session;
    d.size = info.size;
    d.inputName = session.inputNames[0];
    d.canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(info.size, info.size) : Object.assign(document.createElement('canvas'), { width: info.size, height: info.size });
    d.ctx = d.canvas.getContext('2d', { willReadFrequently: true });
    d.input = new Float32Array(3 * info.size * info.size);
    d.busy = false;
    // warm-up run so the first real frame is not slow (shader compilation on WebGPU)
    const warm = lock.then(() => d.session.run({ [d.inputName]: new ort.Tensor('float32', new Float32Array(d.input.length), [1, 3, d.size, d.size]) }));
    lock = warm.catch(() => {});
    await warm;
    if (backendUsed === 'webgpu') {
      // time a few runs: a weak graphics card can be slower than the processor
      const t0 = performance.now();
      for (let i = 0; i < 3; i++) {
        const r = lock.then(() => d.session.run({ [d.inputName]: new ort.Tensor('float32', new Float32Array(d.input.length), [1, 3, d.size, d.size]) }));
        lock = r.catch(() => {});
        await r;
      }
      const per = (performance.now() - t0) / 3;
      d.gpuMs = per;
      trial.set(per > 300 ? 'slow' : 'ok');
    }
    return d;
  }

  // source: video/canvas/ImageBitmap; roi: {x, y, w, h} in source pixels (default: whole frame)
  // returns { boxes: [{x1,y1,x2,y2,score}], ms }. Calls are serialised across all models: the
  // runtime must never run two inferences at the same time.
  detect(source, srcW, srcH, roi, conf = 0.1) {
    const run = lock.then(() => this._detect(source, srcW, srcH, roi, conf));
    lock = run.catch(() => {});
    return run;
  }

  async _detect(source, srcW, srcH, roi, conf) {
    const S = this.size;
    const r0 = roi || { x: 0, y: 0, w: srcW, h: srcH };
    const scale = Math.min(S / r0.w, S / r0.h);
    const nw = Math.round(r0.w * scale), nh = Math.round(r0.h * scale);
    const px = Math.floor((S - nw) / 2), py = Math.floor((S - nh) / 2);
    const ctx = this.ctx;
    ctx.fillStyle = 'rgb(114,114,114)';
    ctx.fillRect(0, 0, S, S);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'medium';
    ctx.drawImage(source, r0.x, r0.y, r0.w, r0.h, px, py, nw, nh);
    const pix = ctx.getImageData(0, 0, S, S).data;
    // with the engine in a worker the buffer is handed over (detached), so it cannot be reused
    if (this.ort.env.wasm.proxy || this.input.length === 0) this.input = new Float32Array(3 * S * S);
    const inp = this.input;
    const plane = S * S;
    for (let i = 0, j = 0; i < plane; i++, j += 4) {
      inp[i] = pix[j] / 255;
      inp[i + plane] = pix[j + 1] / 255;
      inp[i + 2 * plane] = pix[j + 2] / 255;
    }
    const t0 = performance.now();
    const out = await this.session.run({ [this.inputName]: new this.ort.Tensor('float32', inp, [1, 3, S, S]) });
    const ms = performance.now() - t0;
    const tensor = out[this.session.outputNames[0]];
    const data = tensor.data;
    let raw;
    if (this.info.kind === 'e2e') raw = decodeE2E(data, tensor.dims, conf);
    else raw = nms(decodeV8(data, tensor.dims, conf), 0.5);
    const boxes = [];
    for (const b of raw) {
      const x1 = (b[0] - px) / scale + r0.x, y1 = (b[1] - py) / scale + r0.y;
      const x2 = (b[2] - px) / scale + r0.x, y2 = (b[3] - py) / scale + r0.y;
      if (x2 - x1 < 2 || y2 - y1 < 2) continue;
      boxes.push({
        x1: Math.max(r0.x, x1), y1: Math.max(r0.y, y1),
        x2: Math.min(r0.x + r0.w, x2), y2: Math.min(r0.y + r0.h, y2),
        score: b[4],
      });
    }
    if (tensor.dispose) tensor.dispose();
    return { boxes, ms };
  }

  release() {
    try { this.session?.release?.(); } catch { /* ignore */ }
  }
}

// YOLO26 end-to-end head: [1, N, 6] = x1, y1, x2, y2, score, class (no NMS needed)
function decodeE2E(data, dims, conf) {
  const n = dims[1], k = dims[2];
  const res = [];
  for (let i = 0; i < n; i++) {
    const o = i * k;
    let s = data[o + 4];
    if (s < conf) continue;
    const c = Math.round(data[o + 5]);
    if (!COCO_ANIMALS.has(c)) continue;
    if (c !== COCO_SHEEP) s *= 0.85;
    res.push([data[o], data[o + 1], data[o + 2], data[o + 3], s]);
  }
  return res;
}

// YOLOv8-style single-class head: [1, 5, A] = cx, cy, w, h, score
function decodeV8(data, dims, conf) {
  const a = dims[2];
  const res = [];
  for (let i = 0; i < a; i++) {
    const s = data[4 * a + i];
    if (s < conf) continue;
    const cx = data[i], cy = data[a + i], w = data[2 * a + i], h = data[3 * a + i];
    res.push([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2, s]);
  }
  return res;
}

function nms(cands, thr) {
  cands.sort((p, q) => q[4] - p[4]);
  const keep = [];
  for (const b of cands) {
    let ok = true;
    for (const k of keep) {
      const ix = Math.min(b[2], k[2]) - Math.max(b[0], k[0]);
      const iy = Math.min(b[3], k[3]) - Math.max(b[1], k[1]);
      if (ix <= 0 || iy <= 0) continue;
      const inter = ix * iy;
      const u = (b[2] - b[0]) * (b[3] - b[1]) + (k[2] - k[0]) * (k[3] - k[1]) - inter;
      if (inter / u > thr) { ok = false; break; }
    }
    if (ok) keep.push(b);
    if (keep.length >= 300) break;
  }
  return keep;
}
