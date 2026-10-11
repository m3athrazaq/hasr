// Constant-velocity Kalman filter on a box: state [cx, cy, w, h, vcx, vcy, vw, vh].
// Noise is proportional to box size (as in ByteTrack / BoT-SORT). Time is measured in
// "nominal frames" so the filter behaves the same whatever the processing rate.
let SP = 1 / 20;   // position noise weight
let SV = 1 / 160;  // velocity noise weight
export function setNoise(sp, sv) { SP = sp; SV = sv; }

function inv4(S) {
  // Gauss-Jordan inverse of a 4x4 matrix (row-major Float64Array(16)).
  const a = new Float64Array(32);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) a[i * 8 + j] = S[i * 4 + j];
    a[i * 8 + 4 + i] = 1;
  }
  for (let c = 0; c < 4; c++) {
    let piv = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(a[r * 8 + c]) > Math.abs(a[piv * 8 + c])) piv = r;
    if (piv !== c) for (let k = 0; k < 8; k++) { const t = a[c * 8 + k]; a[c * 8 + k] = a[piv * 8 + k]; a[piv * 8 + k] = t; }
    const d = a[c * 8 + c] || 1e-12;
    for (let k = 0; k < 8; k++) a[c * 8 + k] /= d;
    for (let r = 0; r < 4; r++) {
      if (r === c) continue;
      const f = a[r * 8 + c];
      if (!f) continue;
      for (let k = 0; k < 8; k++) a[r * 8 + k] -= f * a[c * 8 + k];
    }
  }
  const out = new Float64Array(16);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) out[i * 4 + j] = a[i * 8 + 4 + j];
  return out;
}

export class BoxKF {
  constructor(z) {
    const [cx, cy, w, h] = z;
    this.x = new Float64Array([cx, cy, w, h, 0, 0, 0, 0]);
    const s = [2 * SP * w, 2 * SP * h, 2 * SP * w, 2 * SP * h, 10 * SV * w, 10 * SV * h, 10 * SV * w, 10 * SV * h];
    this.P = new Float64Array(64);
    for (let i = 0; i < 8; i++) this.P[i * 9] = s[i] * s[i];
  }

  clone() {
    const k = Object.create(BoxKF.prototype);
    k.x = new Float64Array(this.x);
    k.P = new Float64Array(this.P);
    return k;
  }

  // k: elapsed time in nominal frames (may be fractional)
  predict(k) {
    const x = this.x, P = this.P;
    for (let i = 0; i < 4; i++) x[i] += k * x[i + 4];
    if (x[2] < 2) x[2] = 2;
    if (x[3] < 2) x[3] = 2;
    const FP = new Float64Array(64);
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) FP[i * 8 + j] = P[i * 8 + j] + (i < 4 ? k * P[(i + 4) * 8 + j] : 0);
    }
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) P[i * 8 + j] = FP[i * 8 + j] + (j < 4 ? k * FP[i * 8 + j + 4] : 0);
    }
    const w = x[2], h = x[3];
    const q = [SP * w, SP * h, SP * w, SP * h, SV * w, SV * h, SV * w, SV * h];
    const kk = Math.max(k, 0.05);
    for (let i = 0; i < 8; i++) P[i * 9] += q[i] * q[i] * kk;
  }

  update(z) {
    const x = this.x, P = this.P;
    const w = x[2], h = x[3];
    const r = [SP * w, SP * h, SP * w, SP * h];
    const S = new Float64Array(16);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) S[i * 4 + j] = P[i * 8 + j] + (i === j ? r[i] * r[i] : 0);
    const Si = inv4(S);
    const K = new Float64Array(32);
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 4; j++) {
        let s = 0;
        for (let l = 0; l < 4; l++) s += P[i * 8 + l] * Si[l * 4 + j];
        K[i * 4 + j] = s;
      }
    }
    const y = [z[0] - x[0], z[1] - x[1], z[2] - x[2], z[3] - x[3]];
    for (let i = 0; i < 8; i++) {
      let s = 0;
      for (let j = 0; j < 4; j++) s += K[i * 4 + j] * y[j];
      x[i] += s;
    }
    const P2 = new Float64Array(64);
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) {
        let s = 0;
        for (let l = 0; l < 4; l++) s += K[i * 4 + l] * P[l * 8 + j];
        P2[i * 8 + j] = P[i * 8 + j] - s;
      }
    }
    this.P = P2;
  }

  box() {
    const [cx, cy, w, h] = this.x;
    return { x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2 };
  }
}
