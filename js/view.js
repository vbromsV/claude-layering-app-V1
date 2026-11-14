// The main canvas: view transform (zoom/pan) and drawing of layers + UI overlay.
// The view transform is independent of layer transforms.
//   screen = stageCentre + pan + zoom · world

import { state } from './state.js';

export const view = { canvas: null, ctx: null, w: 1, h: 1, dpr: 1 };

let pending = false;
let overlay = () => {};
let onResize = () => {};

export function initView(canvas, stage, { onResized } = {}) {
  view.canvas = canvas;
  view.ctx = canvas.getContext('2d');
  if (onResized) onResize = onResized;
  const resize = () => {
    const r = stage.getBoundingClientRect();
    view.dpr = Math.min(window.devicePixelRatio || 1, 3);
    view.w = Math.max(1, r.width);
    view.h = Math.max(1, r.height);
    canvas.width = Math.round(view.w * view.dpr);
    canvas.height = Math.round(view.h * view.dpr);
    onResize();
    draw();
  };
  new ResizeObserver(resize).observe(stage);
  window.addEventListener('resize', resize);
  resize();
}

export function setOverlay(fn) { overlay = fn; }

export function requestRender() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    draw();
  });
}

export function screenToWorld(sx, sy) {
  const v = state.view;
  return [(sx - view.w / 2 - v.panX) / v.zoom, (sy - view.h / 2 - v.panY) / v.zoom];
}

export function worldToScreen(wx, wy) {
  const v = state.view;
  return [wx * v.zoom + view.w / 2 + v.panX, wy * v.zoom + view.h / 2 + v.panY];
}

/** Zoom the view by factor f keeping screen point (sx, sy) anchored. */
export function zoomAt(sx, sy, f) {
  const v = state.view;
  const nz = Math.min(64, Math.max(0.02, v.zoom * f));
  const [wx, wy] = screenToWorld(sx, sy);
  v.zoom = nz;
  v.panX = sx - view.w / 2 - wx * nz;
  v.panY = sy - view.h / 2 - wy * nz;
}

function draw() {
  const { ctx, dpr, canvas } = view;
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const v = state.view;
  for (const L of state.layers) {
    if (!L.visible || L.opacity <= 0) continue;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(view.w / 2 + v.panX, view.h / 2 + v.panY);
    ctx.scale(v.zoom, v.zoom);
    ctx.translate(L.x, L.y);
    ctx.rotate(L.rot);
    ctx.scale(L.flip ? -L.scale : L.scale, L.scale);
    ctx.globalAlpha = L.opacity;
    // Show real pixels when zoomed in far, smooth otherwise.
    const px = v.zoom * L.scale * dpr;
    ctx.imageSmoothingEnabled = px < 3;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(L.canvas, -L.w / 2, -L.h / 2);
  }
  ctx.globalAlpha = 1;
  ctx.imageSmoothingEnabled = true;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  overlay(ctx);
}
