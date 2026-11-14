// Layer model and pixel pipeline.
//
//   src   original RGBA pixels (never modified)
//   adj   src with colour adjustments applied (=== src when neutral)
//   mask  0..255 visibility per pixel (Erase / Restore)
//   canvas  rendered result: adj RGB, alpha = src alpha × mask
//
// Opacity, transform and flip are applied when drawing, so they are free to change.

let nextId = 1;

export const NEUTRAL_ADJUST = Object.freeze({ brightness: 0, contrast: 0, saturation: 0, hue: 0, gamma: 0 });

export function createLayer(imageData, name) {
  const w = imageData.width, h = imageData.height;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const L = {
    id: nextId++,
    name: name || `Layer ${nextId - 1}`,
    w, h,
    src: imageData.data,
    adj: imageData.data,
    mask: new Uint8Array(w * h).fill(255),
    canvas, ctx,
    x: 0, y: 0, scale: 1, rot: 0, flip: false,
    opacity: 1,
    visible: true,
    adjust: { ...NEUTRAL_ADJUST },
  };
  ctx.putImageData(imageData, 0, 0);
  return L;
}

/** Re-render a rectangle of the layer canvas from adj + mask. */
export function refreshRect(L, x, y, w, h) {
  let x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(L.w, Math.ceil(x + w)), y1 = Math.min(L.h, Math.ceil(y + h));
  const rw = x1 - x0, rh = y1 - y0;
  if (rw <= 0 || rh <= 0) return;
  const out = new ImageData(rw, rh);
  const o = out.data, a = L.adj, m = L.mask, W = L.w;
  let q = 0;
  for (let yy = y0; yy < y1; yy++) {
    let i = yy * W + x0;
    let p = i * 4;
    for (let xx = 0; xx < rw; xx++, i++, p += 4, q += 4) {
      o[q] = a[p];
      o[q + 1] = a[p + 1];
      o[q + 2] = a[p + 2];
      o[q + 3] = (a[p + 3] * m[i] + 127) / 255;
    }
  }
  L.ctx.putImageData(out, x0, y0);
}

export function refreshAll(L) {
  refreshRect(L, 0, 0, L.w, L.h);
}

export function isNeutral(a) {
  return !a.brightness && !a.contrast && !a.saturation && !a.hue && !a.gamma;
}

/** Build tone LUT + 3×3 colour matrix for an adjustment set. */
function buildAdjust(a) {
  const lut = new Uint8ClampedArray(256);
  const gExp = Math.pow(2, -a.gamma / 50);                          // +100 → exponent 0.25 (brighter mid-tones)
  const cf = a.contrast >= 0 ? 1 + (a.contrast / 100) * 2 : 1 + a.contrast / 100; // 0 … 3
  const bOff = (a.brightness / 100) * 128;
  for (let v = 0; v < 256; v++) {
    let x = 255 * Math.pow(v / 255, gExp);
    x = (x - 127.5) * cf + 127.5;
    x += bOff;
    lut[v] = x;
  }
  // Saturation then hue rotation (same weights as CSS filter effects).
  const s = 1 + a.saturation / 100;
  const S = [
    0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s,
  ];
  const r = (a.hue * Math.PI) / 180, c = Math.cos(r), n = Math.sin(r);
  const Hm = [
    0.213 + c * 0.787 - n * 0.213, 0.715 - c * 0.715 - n * 0.715, 0.072 - c * 0.072 + n * 0.928,
    0.213 - c * 0.213 + n * 0.143, 0.715 + c * 0.285 + n * 0.140, 0.072 - c * 0.072 - n * 0.283,
    0.213 - c * 0.213 - n * 0.787, 0.715 - c * 0.715 + n * 0.715, 0.072 + c * 0.928 + n * 0.072,
  ];
  const M = new Float32Array(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      M[i * 3 + j] = Hm[i * 3] * S[j] + Hm[i * 3 + 1] * S[3 + j] + Hm[i * 3 + 2] * S[6 + j];
  const useMatrix = a.saturation !== 0 || a.hue !== 0;
  return { lut, M, useMatrix };
}

/** Recompute adj from src (non-destructive) and refresh the canvas. */
export function applyAdjust(L) {
  if (isNeutral(L.adjust)) {
    L.adj = L.src;
  } else {
    if (L.adj === L.src) L.adj = new Uint8ClampedArray(L.src.length);
    const { lut, M, useMatrix } = buildAdjust(L.adjust);
    const s = L.src, d = L.adj, n = s.length;
    if (useMatrix) {
      const m0 = M[0], m1 = M[1], m2 = M[2], m3 = M[3], m4 = M[4], m5 = M[5], m6 = M[6], m7 = M[7], m8 = M[8];
      for (let p = 0; p < n; p += 4) {
        const r = lut[s[p]], g = lut[s[p + 1]], b = lut[s[p + 2]];
        d[p] = m0 * r + m1 * g + m2 * b;
        d[p + 1] = m3 * r + m4 * g + m5 * b;
        d[p + 2] = m6 * r + m7 * g + m8 * b;
        d[p + 3] = s[p + 3];
      }
    } else {
      for (let p = 0; p < n; p += 4) {
        d[p] = lut[s[p]];
        d[p + 1] = lut[s[p + 1]];
        d[p + 2] = lut[s[p + 2]];
        d[p + 3] = s[p + 3];
      }
    }
  }
  refreshAll(L);
}

/** Render the layer standalone (own pixel coords) with flip + opacity baked in. */
export function renderLayerStandalone(L) {
  const c = document.createElement('canvas');
  c.width = L.w;
  c.height = L.h;
  const ctx = c.getContext('2d');
  if (L.flip) {
    ctx.translate(L.w, 0);
    ctx.scale(-1, 1);
  }
  ctx.globalAlpha = L.opacity;
  ctx.drawImage(L.canvas, 0, 0);
  return c;
}
