// Erase / Restore brush, including Magic (contiguous colour-matched) mode.
//
// A stroke keeps a copy of the mask at stroke start and a per-pixel coverage buffer.
// Each pixel's coverage is the max of all dabs during the stroke, and the mask is
//   erase:   start · (1 − cov·strength)
//   restore: start + (255 − start) · cov·strength
// so one stroke never over-applies, while repeated strokes build up the effect.

import { refreshRect } from './layer.js';

let covBuf = null;
let visBuf = null;
let visStamp = 0;
let queue = null;

const MAX_DABS_PER_SEGMENT = 4000;
const COLOR_MAX = 441.6729559300637; // √(3·255²)

export class Stroke {
  constructor(L, mode, brush) {
    this.L = L;
    this.erase = mode === 'erase';
    this.hardness = brush.hardness / 100;
    this.strength = brush.strength / 100;
    this.magic = !!brush.magic;
    const thr = (brush.tolerance / 100) * COLOR_MAX;
    this.thr2 = thr * thr;
    const n = L.w * L.h;
    if (!covBuf || covBuf.length !== n) covBuf = new Uint8Array(n);
    else covBuf.fill(0);
    this.cov = covBuf;
    this.start = L.mask.slice();
    this.last = null;
    this.dirty = null;
    this.batch = null;
  }

  /** Add a point in image pixel coordinates with radius r (image px). */
  addPoint(x, y, r) {
    if (this.last) {
      const [lx, ly] = this.last;
      const dist = Math.hypot(x - lx, y - ly);
      const step = Math.max(0.5, r * (this.magic ? 0.25 : 0.15));
      const n = Math.min(MAX_DABS_PER_SEGMENT, Math.max(1, Math.ceil(dist / step)));
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        this.dab(lx + (x - lx) * t, ly + (y - ly) * t, r);
      }
    } else {
      this.dab(x, y, r);
    }
    this.last = [x, y];
    this.flush();
  }

  falloff(d, r) {
    if (d > r) return 0;
    const inner = r * this.hardness;
    if (d <= inner) return 1;
    const fe = r - inner;
    if (fe <= 1e-6) return 1;
    let t = 1 - (d - inner) / fe;
    return t * t * (3 - 2 * t);
  }

  applyPixel(i, f) {
    const c = (f * 255 + 0.5) | 0;
    const cov = this.cov;
    if (c <= cov[i]) return;
    cov[i] = c;
    const k = (c / 255) * this.strength;
    const b = this.start[i];
    this.L.mask[i] = this.erase ? b * (1 - k) + 0.5 : b + (255 - b) * k + 0.5;
  }

  markBatch(x0, y0, x1, y1) {
    const b = this.batch;
    if (!b) this.batch = { x0, y0, x1, y1 };
    else {
      if (x0 < b.x0) b.x0 = x0;
      if (y0 < b.y0) b.y0 = y0;
      if (x1 > b.x1) b.x1 = x1;
      if (y1 > b.y1) b.y1 = y1;
    }
  }

  dab(cx, cy, r) {
    const L = this.L, W = L.w, H = L.h;
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(W - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(H - 1, Math.ceil(cy + r));
    if (x0 > x1 || y0 > y1) return;
    if (this.magic) return this.magicDab(cx, cy, r);
    const r2 = r * r;
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - cy;
      let i = y * W + x0;
      for (let x = x0; x <= x1; x++, i++) {
        const dx = x + 0.5 - cx;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const f = this.falloff(Math.sqrt(d2), r);
        if (f > 0) this.applyPixel(i, f);
      }
    }
    this.markBatch(x0, y0, x1, y1);
  }

  /**
   * Magic dab: flood fill (4-connected) from the brush centre through pixels that are
   * inside the brush circle and within colour tolerance of a reference colour sampled
   * (3×3 average) at the centre. Non-matching pixels act as barriers.
   */
  magicDab(cx, cy, r) {
    const L = this.L, W = L.w, H = L.h, a = L.adj;
    const ix = Math.floor(cx), iy = Math.floor(cy);
    if (ix < 0 || iy < 0 || ix >= W || iy >= H) return;

    let sr = 0, sg = 0, sb = 0, sn = 0;
    for (let y = Math.max(0, iy - 1); y <= Math.min(H - 1, iy + 1); y++) {
      for (let x = Math.max(0, ix - 1); x <= Math.min(W - 1, ix + 1); x++) {
        const p = (y * W + x) * 4;
        sr += a[p]; sg += a[p + 1]; sb += a[p + 2]; sn++;
      }
    }
    sr /= sn; sg /= sn; sb /= sn;

    const n = W * H;
    if (!visBuf || visBuf.length !== n) { visBuf = new Int32Array(n); visStamp = 0; }
    if (++visStamp > 2e9) { visBuf.fill(0); visStamp = 1; }
    const stamp = visStamp, vis = visBuf;
    const span = 2 * Math.ceil(r) + 4;
    if (!queue || queue.length < span * span) queue = new Int32Array(span * span);
    const q = queue, thr2 = this.thr2, r2 = r * r;

    let bx0 = ix, by0 = iy, bx1 = ix, by1 = iy;
    let qh = 0, qt = 0;
    const s0 = iy * W + ix;
    vis[s0] = stamp;
    q[qt++] = s0;

    const tryPush = (j, nx, ny) => {
      if (vis[j] === stamp) return;
      const dx = nx + 0.5 - cx, dy = ny + 0.5 - cy;
      if (dx * dx + dy * dy > r2) return;
      const p = j * 4;
      const dr = a[p] - sr, dg = a[p + 1] - sg, db = a[p + 2] - sb;
      if (dr * dr + dg * dg + db * db > thr2) return;
      vis[j] = stamp;
      q[qt++] = j;
    };

    while (qh < qt) {
      const i = q[qh++];
      const x = i % W, y = (i - x) / W;
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const f = this.falloff(Math.sqrt(dx * dx + dy * dy), r);
      if (f > 0) this.applyPixel(i, f);
      if (x < bx0) bx0 = x; else if (x > bx1) bx1 = x;
      if (y < by0) by0 = y; else if (y > by1) by1 = y;
      if (x > 0) tryPush(i - 1, x - 1, y);
      if (x < W - 1) tryPush(i + 1, x + 1, y);
      if (y > 0) tryPush(i - W, x, y - 1);
      if (y < H - 1) tryPush(i + W, x, y + 1);
    }
    this.markBatch(bx0, by0, bx1, by1);
  }

  flush() {
    const b = this.batch;
    if (!b) return;
    this.batch = null;
    refreshRect(this.L, b.x0, b.y0, b.x1 - b.x0 + 1, b.y1 - b.y0 + 1);
    const d = this.dirty;
    if (!d) this.dirty = { ...b };
    else {
      d.x0 = Math.min(d.x0, b.x0); d.y0 = Math.min(d.y0, b.y0);
      d.x1 = Math.max(d.x1, b.x1); d.y1 = Math.max(d.y1, b.y1);
    }
  }

  /** Finish the stroke. Returns {x,y,w,h,before,after} for undo, or null if nothing changed. */
  finish() {
    this.flush();
    const d = this.dirty;
    const start = this.start;
    this.start = null;
    if (!d) return null;
    const L = this.L;
    const w = d.x1 - d.x0 + 1, h = d.y1 - d.y0 + 1;
    const before = new Uint8Array(w * h), after = new Uint8Array(w * h);
    let changed = false;
    for (let row = 0; row < h; row++) {
      const off = (d.y0 + row) * L.w + d.x0;
      before.set(start.subarray(off, off + w), row * w);
      after.set(L.mask.subarray(off, off + w), row * w);
    }
    for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) { changed = true; break; }
    if (!changed) return null;
    return { x: d.x0, y: d.y0, w, h, before, after };
  }
}

/** Write a saved mask region back into the layer and refresh it. */
export function writeMaskRegion(L, r, data) {
  for (let row = 0; row < r.h; row++) {
    L.mask.set(data.subarray(row * r.w, (row + 1) * r.w), (r.y + row) * L.w + r.x);
  }
  refreshRect(L, r.x, r.y, r.w, r.h);
}
