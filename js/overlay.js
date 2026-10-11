// Draws the counting line, detection area and tracked sheep over the video, and lets the user
// draw/adjust the line and the area with a finger or the mouse. Geometry is stored normalised (0..1).

export class Overlay {
  constructor(stage, video, canvas) {
    this.stage = stage;
    this.video = video;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.line = null;          // {x1,y1,x2,y2} normalised
    this.dir = 1;
    this.roi = null;           // {x,y,w,h} normalised or null
    this.tool = 'line';        // 'line' | 'roi' | 'none'
    this.editable = true;
    this.tracks = [];
    this.flash = 0;
    this.flashDir = 1;
    this.onChange = null;
    this.hint = '';
    this.colors = { line: '#F2C230', arrow: '#F2C230', box: 'rgba(255,255,255,0.9)', counted: '#3DDC84', tentative: 'rgba(255,255,255,0.35)', flagged: '#FF9F43', dim: 'rgba(5,10,15,0.55)' };
    this._drag = null;
    this._bind();
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(stage);
    this.resize();
  }

  resize() {
    const r = this.stage.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.cw = r.width; this.ch = r.height; this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.canvas.style.width = r.width + 'px';
    this.canvas.style.height = r.height + 'px';
    this.draw();
  }

  // displayed video rectangle inside the stage (object-fit: contain)
  vrect() {
    const vw = this.video.videoWidth || 16, vh = this.video.videoHeight || 9;
    const s = Math.min(this.cw / vw, this.ch / vh);
    const w = vw * s, h = vh * s;
    return { x: (this.cw - w) / 2, y: (this.ch - h) / 2, w, h, s, vw, vh };
  }
  toScreen(nx, ny) { const r = this.vrect(); return [r.x + nx * r.w, r.y + ny * r.h]; }
  toNorm(sx, sy) { const r = this.vrect(); return [Math.min(1, Math.max(0, (sx - r.x) / r.w)), Math.min(1, Math.max(0, (sy - r.y) / r.h))]; }

  _bind() {
    const c = this.canvas;
    const pos = (e) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    c.addEventListener('pointerdown', (e) => {
      if (!this.editable || this.tool === 'none') return;
      c.setPointerCapture(e.pointerId);
      const [sx, sy] = pos(e);
      const [nx, ny] = this.toNorm(sx, sy);
      if (this.tool === 'line') {
        // grab an endpoint if close to one, otherwise start a new line
        if (this.line) {
          const [ax, ay] = this.toScreen(this.line.x1, this.line.y1);
          const [bx, by] = this.toScreen(this.line.x2, this.line.y2);
          if (Math.hypot(sx - ax, sy - ay) < 28) { this._drag = { kind: 'p1' }; return; }
          if (Math.hypot(sx - bx, sy - by) < 28) { this._drag = { kind: 'p2' }; return; }
        }
        this._drag = { kind: 'new', x: nx, y: ny, sx, sy, prev: this.line };
        this.line = { x1: nx, y1: ny, x2: nx, y2: ny };
      } else if (this.tool === 'roi') {
        this._drag = { kind: 'roi', x: nx, y: ny, prev: this.roi };
        this.roi = { x: nx, y: ny, w: 0, h: 0 };
      }
      this.draw();
    });
    c.addEventListener('pointermove', (e) => {
      if (!this._drag) return;
      const [sx, sy] = pos(e);
      const [nx, ny] = this.toNorm(sx, sy);
      const d = this._drag;
      if (d.kind === 'p1') { this.line.x1 = nx; this.line.y1 = ny; }
      else if (d.kind === 'p2' || d.kind === 'new') { this.line.x2 = nx; this.line.y2 = ny; }
      else if (d.kind === 'roi') {
        this.roi = { x: Math.min(d.x, nx), y: Math.min(d.y, ny), w: Math.abs(nx - d.x), h: Math.abs(ny - d.y) };
      }
      this.draw();
    });
    const end = () => {
      if (!this._drag) return;
      const d = this._drag;
      this._drag = null;
      if (d.kind === 'new') {
        const [ax, ay] = this.toScreen(this.line.x1, this.line.y1);
        const [bx, by] = this.toScreen(this.line.x2, this.line.y2);
        if (Math.hypot(bx - ax, by - ay) < 30) this.line = d.prev; // a tap, not a line
      }
      if (d.kind === 'roi' && (this.roi.w < 0.05 || this.roi.h < 0.05)) this.roi = d.prev;
      this.draw();
      this.onChange?.();
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
  }

  setTracks(tracks) { this.tracks = tracks; }
  pulse(dir) { this.flash = performance.now(); this.flashDir = dir; }

  draw() {
    const ctx = this.ctx;
    const { dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.cw, this.ch);
    if (!this.video.videoWidth) return;
    const r = this.vrect();
    // detection area: dim everything outside it
    if (this.roi && this.roi.w > 0 && this.roi.h > 0) {
      const [x, y] = this.toScreen(this.roi.x, this.roi.y);
      const w = this.roi.w * r.w, h = this.roi.h * r.h;
      ctx.save();
      ctx.fillStyle = this.colors.dim;
      ctx.beginPath();
      ctx.rect(r.x, r.y, r.w, r.h);
      ctx.rect(x, y, w, h);
      ctx.fill('evenodd');
      ctx.setLineDash([8, 6]);
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x, y, w, h);
      ctx.restore();
    }
    // tracked sheep
    const sx = r.w / r.vw, sy = r.h / r.vh;
    ctx.lineWidth = 2;
    ctx.font = '600 12px "Readex Pro", system-ui, sans-serif';
    for (const tr of this.tracks) {
      const x = r.x + tr.x1 * sx, y = r.y + tr.y1 * sy, w = (tr.x2 - tr.x1) * sx, h = (tr.y2 - tr.y1) * sy;
      ctx.strokeStyle = tr.flag ? this.colors.flagged : tr.counted ? this.colors.counted : tr.tentative ? this.colors.tentative : this.colors.box;
      ctx.lineWidth = tr.counted ? 3 : 2;
      roundRect(ctx, x, y, w, h, 6);
      ctx.stroke();
      if (!tr.tentative && w > 26) {
        ctx.fillStyle = ctx.strokeStyle;
        ctx.fillText(String(tr.id), x + 5, y + 14);
      }
    }
    // counting line + direction arrow
    if (this.line) {
      const [ax, ay] = this.toScreen(this.line.x1, this.line.y1);
      const [bx, by] = this.toScreen(this.line.x2, this.line.y2);
      const age = (performance.now() - this.flash) / 1000;
      const glow = age < 0.45 ? 1 - age / 0.45 : 0;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.lineWidth = 9;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      ctx.strokeStyle = glow ? (this.flashDir > 0 ? `rgba(61,220,132,${0.6 + 0.4 * glow})` : `rgba(255,95,87,${0.6 + 0.4 * glow})`) : this.colors.line;
      ctx.lineWidth = 4 + 6 * glow;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      for (const [px, py] of [[ax, ay], [bx, by]]) {
        ctx.fillStyle = this.colors.line;
        ctx.beginPath(); ctx.arc(px, py, this.editable ? 9 : 5, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 2; ctx.stroke();
      }
      // arrow from the middle of the line towards the destination side (same normal as the counter)
      const L = Math.hypot(bx - ax, by - ay);
      if (L > 20) {
        // the counter works in frame pixels; convert its normal to screen space
        const fx1 = this.line.x1 * r.vw, fy1 = this.line.y1 * r.vh, fx2 = this.line.x2 * r.vw, fy2 = this.line.y2 * r.vh;
        const fl = Math.hypot(fx2 - fx1, fy2 - fy1) || 1;
        const ux = (fx2 - fx1) / fl, uy = (fy2 - fy1) / fl;
        let nx = uy * this.dir, ny = -ux * this.dir;
        const nl = Math.hypot(nx * sx, ny * sy) || 1;
        nx = nx * sx / nl; ny = ny * sy / nl;
        const mx = (ax + bx) / 2, my = (ay + by) / 2;
        const len = Math.min(70, Math.max(36, L * 0.22));
        const tx = mx + nx * len, ty = my + ny * len;
        ctx.strokeStyle = this.colors.arrow;
        ctx.fillStyle = this.colors.arrow;
        ctx.lineWidth = 5;
        ctx.beginPath(); ctx.moveTo(mx - nx * 8, my - ny * 8); ctx.lineTo(tx, ty); ctx.stroke();
        const hx = -ny, hy = nx;
        ctx.beginPath();
        ctx.moveTo(tx + nx * 14, ty + ny * 14);
        ctx.lineTo(tx + hx * 11, ty + hy * 11);
        ctx.lineTo(tx - hx * 11, ty - hy * 11);
        ctx.closePath(); ctx.fill();
      }
      ctx.restore();
    }
  }
}

export function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
