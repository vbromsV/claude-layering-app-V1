// PNG export of the whole composition (with crop step) and of single layers.

import { state } from './state.js';
import { boundsOf } from './geom.js';
import { renderLayerStandalone } from './layer.js';
import { cropImage } from './crop.js';
import { toast, download, timestamp, canvasToBlob } from './ui.js';

const MAX_SIDE = 8192;
const PREVIEW_SIDE = 1600;

/** Draw visible layers into ctx so that world (wx0, wy0) maps to (0,0) at ppw pixels per world unit. */
export function renderComposition(ctx, wx0, wy0, ppw) {
  for (const L of state.layers) {
    if (!L.visible || L.opacity <= 0) continue;
    ctx.setTransform(ppw, 0, 0, ppw, -wx0 * ppw, -wy0 * ppw);
    ctx.translate(L.x, L.y);
    ctx.rotate(L.rot);
    ctx.scale(L.flip ? -L.scale : L.scale, L.scale);
    ctx.globalAlpha = L.opacity;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(L.canvas, -L.w / 2, -L.h / 2);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
}

/**
 * Output resolution: the highest native resolution among visible layers
 * (so no layer is downsampled), limited to MAX_SIDE and a pixel budget.
 */
function chooseResolution(b, layers) {
  let ppw = 0;
  for (const L of layers) ppw = Math.max(ppw, 1 / L.scale);
  const maxArea = state.mobile ? 24e6 : 48e6;
  ppw = Math.min(ppw, MAX_SIDE / Math.max(b.w, b.h), Math.sqrt(maxArea / Math.max(1e-9, b.w * b.h)));
  return ppw;
}

export async function exportComposition() {
  const layers = state.layers.filter((l) => l.visible && l.opacity > 0);
  if (!layers.length) {
    toast('Nothing to export – no visible layers.');
    return;
  }
  const b = boundsOf(layers);
  const ppw = chooseResolution(b, layers);
  const fullW = b.w * ppw, fullH = b.h * ppw;

  // Preview for the crop selector.
  const ps = Math.min(1, PREVIEW_SIDE / Math.max(fullW, fullH));
  const pw = Math.max(1, Math.round(fullW * ps)), ph = Math.max(1, Math.round(fullH * ps));
  const preview = document.createElement('canvas');
  preview.width = pw;
  preview.height = ph;
  renderComposition(preview.getContext('2d'), b.x, b.y, pw / b.w);

  const kx = fullW / pw, ky = fullH / ph; // preview px → output px
  const rect = await cropImage({
    image: preview,
    width: pw,
    height: ph,
    title: 'Export PNG',
    checker: true,
    describe: (r) => `${Math.max(1, Math.round(r.w * kx))} × ${Math.max(1, Math.round(r.h * ky))} px`,
  });
  if (!rect) return;

  try {
    const outW = Math.max(1, Math.round(rect.w * kx));
    const outH = Math.max(1, Math.round(rect.h * ky));
    const wx0 = b.x + (rect.x * kx) / ppw;
    const wy0 = b.y + (rect.y * ky) / ppw;
    const out = document.createElement('canvas');
    out.width = outW;
    out.height = outH;
    const ctx = out.getContext('2d');
    if (!ctx) throw new Error('Canvas too large');
    renderComposition(ctx, wx0, wy0, ppw);
    const blob = await canvasToBlob(out);
    download(blob, `layering-${timestamp()}.png`);
    toast(`Saved PNG (${outW} × ${outH} px)`);
  } catch (err) {
    console.error(err);
    toast('Export failed. Try a smaller crop area.');
  }
}

export async function exportLayer(L) {
  try {
    const c = renderLayerStandalone(L);
    const blob = await canvasToBlob(c);
    const base = (L.name || 'layer').replace(/\.[a-z0-9]+$/i, '').replace(/[^\w\-]+/g, '_').slice(0, 40) || 'layer';
    download(blob, `${base}-layer-${timestamp()}.png`);
    toast(`Exported layer (${L.w} × ${L.h} px)`);
  } catch (err) {
    console.error(err);
    toast('Layer export failed.');
  }
}
