import { state, activeLayer, brushOffset, TOOLS, TOOL_LABEL } from './state.js';
import { createLayer, applyAdjust } from './layer.js';
import { Stroke, writeMaskRegion } from './brush.js';
import * as history from './history.js';
import { cropImage } from './crop.js';
import { exportComposition, exportLayer } from './export.js';
import { view, initView, requestRender, setOverlay, screenToWorld, worldToScreen, zoomAt } from './view.js';
import { layerToWorld, worldToImage, layerCorners, boundsOf, getTransform, setTransform, sameTransform, clamp } from './geom.js';
import { toast, signed } from './ui.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const canvas = $('view');

// ---------------------------------------------------------------------------
// Platform mode: "mobile" = no fine pointer (phones). ?mode=mobile|pc overrides.
// ---------------------------------------------------------------------------
const params = new URLSearchParams(location.search);
function detectMobile() {
  const m = params.get('mode');
  if (m === 'mobile') return true;
  if (m === 'pc') return false;
  return !matchMedia('(any-pointer: fine)').matches;
}
function applyMode() {
  state.mobile = detectMobile();
  document.body.classList.toggle('mobile', state.mobile);
  requestRender();
}
applyMode();
matchMedia('(any-pointer: fine)').addEventListener?.('change', applyMode);

// Working-copy pixel budget per layer (keeps memory + brush responsive).
const maxLayerPixels = () => (state.mobile ? 4e6 : 12e6);

// ---------------------------------------------------------------------------
// UI refresh
// ---------------------------------------------------------------------------
const adjInputs = [...document.querySelectorAll('input[data-adj]')];

function updateUI() {
  const L = activeLayer();
  const has = !!L;

  $('toolName').textContent = TOOL_LABEL[state.tool];
  for (const t of TOOLS) stage.classList.toggle(`tool-${t}`, state.tool === t);
  for (const el of document.querySelectorAll('.tool-settings')) {
    el.classList.toggle('on', el.dataset.for.split(' ').includes(state.tool));
  }

  $('btnFlip').hidden = !(state.tool === 'move' && has);
  $('empty').hidden = state.layers.length > 0;
  $('layerCount').textContent = state.layers.length;

  const op = $('opacity');
  op.disabled = !has;
  if (!opDrag) op.value = has ? Math.round(L.opacity * 100) : 100;
  $('opacityVal').textContent = `${has ? Math.round(L.opacity * 100) : 100}%`;

  for (const inp of adjInputs) {
    const key = inp.dataset.adj;
    inp.disabled = !has;
    const v = has ? L.adjust[key] : 0;
    if (!adjDrag) inp.value = v;
    inp.nextElementSibling.textContent = signed(v) + (key === 'hue' ? '°' : '');
  }

  $('btnUndo').disabled = !history.canUndo();
  $('btnRedo').disabled = !history.canRedo();
  $('zoomVal').textContent = `${Math.round(state.view.zoom * 100)}%`;
  $('tolRow').hidden = !state.brush.magic;
  $('btnMagic').setAttribute('aria-pressed', String(state.brush.magic));
  $('btnIndicator').setAttribute('aria-pressed', String(state.brush.indicator));

  if (!$('layersPanel').hidden) renderLayerList();
}

function changed() {
  updateUI();
  requestRender();
}
history.onChange(changed);

// ---------------------------------------------------------------------------
// Layer operations (all undoable)
// ---------------------------------------------------------------------------
function setActive(id) {
  state.activeId = id;
  changed();
}

function removeFromList(L) {
  const i = state.layers.indexOf(L);
  if (i < 0) return -1;
  state.layers.splice(i, 1);
  if (state.activeId === L.id) {
    const next = state.layers[i - 1] || state.layers[i] || null;
    state.activeId = next ? next.id : null;
  }
  return i;
}

function addLayer(L) {
  const idx = state.layers.length;
  const prevActive = state.activeId;
  state.layers.push(L);
  state.activeId = L.id;
  history.push({
    undo() {
      removeFromList(L);
      if (state.layers.some((l) => l.id === prevActive)) state.activeId = prevActive;
    },
    redo() {
      state.layers.splice(Math.min(idx, state.layers.length), 0, L);
      state.activeId = L.id;
    },
  });
}

function deleteLayer(L) {
  const wasActive = state.activeId === L.id;
  const idx = removeFromList(L);
  if (idx < 0) return;
  history.push({
    undo() {
      state.layers.splice(Math.min(idx, state.layers.length), 0, L);
      if (wasActive) state.activeId = L.id;
    },
    redo() { removeFromList(L); },
  });
}

function moveLayer(L, dir) {
  const i = state.layers.indexOf(L);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= state.layers.length) return;
  const before = state.layers.slice();
  state.layers.splice(i, 1);
  state.layers.splice(j, 0, L);
  const after = state.layers.slice();
  history.push({
    undo() { state.layers = before.slice(); },
    redo() { state.layers = after.slice(); },
  });
}

function toggleVisible(L) {
  const v = !L.visible;
  L.visible = v;
  history.push({ undo() { L.visible = !v; }, redo() { L.visible = v; } });
}

function commitTransform(L, before, key) {
  const after = getTransform(L);
  if (sameTransform(before, after)) return;
  history.push({
    key,
    before,
    after,
    undo() { setTransform(L, this.before); },
    redo() { setTransform(L, this.after); },
    merge(next) { this.after = next.after; },
  });
}

function flipActive() {
  const L = activeLayer();
  if (!L) return;
  const before = getTransform(L);
  L.flip = !L.flip;
  commitTransform(L, before);
  requestRender();
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------
async function decodeImage(file) {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      /* fall back below */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function layerFromImage(img, rect, name) {
  let w = rect.w, h = rect.h;
  const k = Math.min(1, Math.sqrt(maxLayerPixels() / (w * h)));
  const tw = Math.max(1, Math.round(w * k)), th = Math.max(1, Math.round(h * k));
  const c = document.createElement('canvas');
  c.width = tw;
  c.height = th;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, tw, th);
  const data = ctx.getImageData(0, 0, tw, th);
  const L = createLayer(data, name);
  return { L, reduced: k < 1 };
}

function placeNewLayer(L) {
  // Centre of the visible view; fit ~72 % of the visible canvas, proportionally.
  const [cx, cy] = screenToWorld(view.w / 2, view.h / 2);
  const vw = view.w / state.view.zoom, vh = view.h / state.view.zoom;
  L.scale = 0.72 * Math.min(vw / L.w, vh / L.h);
  L.x = cx;
  L.y = cy;
}

let importing = false;
async function importFiles(files) {
  if (importing || !files.length) return;
  importing = true;
  try {
    const n = files.length;
    for (let i = 0; i < n; i++) {
      const f = files[i];
      let img;
      try {
        img = await decodeImage(f);
        if (!img.width || !img.height) throw new Error('empty image');
      } catch (err) {
        console.warn(err);
        toast(`Could not read "${f.name}". The format may not be supported.`, 3500);
        continue;
      }
      const rect = await cropImage({
        image: img,
        width: img.width,
        height: img.height,
        title: n > 1 ? `Crop image ${i + 1} of ${n}` : 'Crop image',
      });
      if (!rect) {
        img.close?.();
        continue;
      }
      try {
        const { L, reduced } = layerFromImage(img, rect, f.name);
        placeNewLayer(L);
        addLayer(L);
        if (reduced) toast(`Large image reduced to ${L.w} × ${L.h} px for smooth editing.`, 3200);
      } catch (err) {
        console.error(err);
        toast(`Could not import "${f.name}".`);
      } finally {
        img.close?.();
      }
      changed();
    }
  } finally {
    importing = false;
  }
}

$('btnLoad').addEventListener('click', () => {
  if (importing) return;
  const fi = $('fileInput');
  fi.value = '';
  fi.click();
});
$('fileInput').addEventListener('change', (e) => importFiles([...e.target.files]));

$('btnSave').addEventListener('click', () => exportComposition());

// ---------------------------------------------------------------------------
// Top bar: opacity
// ---------------------------------------------------------------------------
let opDrag = null;
$('opacity').addEventListener('input', (e) => {
  const L = activeLayer();
  if (!L) return;
  if (!opDrag) opDrag = { L, v: L.opacity };
  L.opacity = e.target.value / 100;
  $('opacityVal').textContent = `${e.target.value}%`;
  requestRender();
});
$('opacity').addEventListener('change', () => {
  if (!opDrag) return;
  const { L, v } = opDrag;
  opDrag = null;
  const nv = L.opacity;
  if (nv !== v) history.push({ undo() { L.opacity = v; }, redo() { L.opacity = nv; } });
});

// ---------------------------------------------------------------------------
// Bottom panel
// ---------------------------------------------------------------------------
$('btnUndo').addEventListener('click', () => history.undo());
$('btnRedo').addEventListener('click', () => history.redo());
$('btnCollapse').addEventListener('click', () => {
  const p = $('panel');
  const c = p.classList.toggle('collapsed');
  $('btnCollapse').setAttribute('aria-expanded', String(!c));
  $('btnCollapse').setAttribute('aria-label', c ? 'Expand tool panel' : 'Collapse tool panel');
});
$('btnTool').addEventListener('click', () => {
  cancelGestures();
  state.tool = TOOLS[(TOOLS.indexOf(state.tool) + 1) % TOOLS.length];
  changed();
});
$('btnFlip').addEventListener('click', flipActive);

// Brush settings
function bindSlider(id, key, fmt) {
  const inp = $(id), out = $(`${id}Val`);
  inp.value = state.brush[key];
  out.textContent = fmt(state.brush[key]);
  inp.addEventListener('input', () => {
    state.brush[key] = Number(inp.value);
    out.textContent = fmt(state.brush[key]);
    requestRender();
  });
}
bindSlider('brushSize', 'size', (v) => String(v));
bindSlider('brushHard', 'hardness', (v) => `${v}%`);
bindSlider('brushStrength', 'strength', (v) => `${v}%`);
bindSlider('brushTol', 'tolerance', (v) => `${v}%`);
bindSlider('brushOffset', 'offset', (v) => String(v));
$('btnMagic').addEventListener('click', () => { state.brush.magic = !state.brush.magic; updateUI(); });
$('btnIndicator').addEventListener('click', () => { state.brush.indicator = !state.brush.indicator; changed(); });

// Zoom settings
function fitView() {
  const layers = state.layers.filter((l) => l.visible);
  const b = boundsOf(layers.length ? layers : state.layers);
  const v = state.view;
  if (!b) {
    v.zoom = 1; v.panX = 0; v.panY = 0;
  } else {
    v.zoom = clamp(Math.min((view.w * 0.9) / b.w, (view.h * 0.9) / b.h), 0.02, 64);
    v.panX = -(b.x + b.w / 2) * v.zoom;
    v.panY = -(b.y + b.h / 2) * v.zoom;
  }
  changed();
}
$('btnFit').addEventListener('click', fitView);
$('btn100').addEventListener('click', () => {
  zoomAt(view.w / 2, view.h / 2, 1 / state.view.zoom);
  changed();
});

// Adjust
let adjDrag = null;
let adjFrame = 0;
function scheduleAdjust(L) {
  if (adjFrame) return;
  adjFrame = requestAnimationFrame(() => {
    adjFrame = 0;
    applyAdjust(L);
    requestRender();
  });
}
function commitAdjust(L, before) {
  const after = { ...L.adjust };
  if (Object.keys(after).every((k) => after[k] === before[k])) return;
  history.push({
    undo() { L.adjust = { ...before }; applyAdjust(L); },
    redo() { L.adjust = { ...after }; applyAdjust(L); },
  });
}
for (const inp of adjInputs) {
  const key = inp.dataset.adj;
  inp.addEventListener('input', () => {
    const L = activeLayer();
    if (!L) return;
    if (!adjDrag) adjDrag = { L, before: { ...L.adjust } };
    L.adjust[key] = Number(inp.value);
    inp.nextElementSibling.textContent = signed(L.adjust[key]) + (key === 'hue' ? '°' : '');
    scheduleAdjust(L);
  });
  inp.addEventListener('change', () => {
    if (!adjDrag) return;
    const { L, before } = adjDrag;
    adjDrag = null;
    commitAdjust(L, before);
  });
}
for (const out of document.querySelectorAll('output[data-reset]')) {
  out.addEventListener('click', () => {
    const L = activeLayer();
    const key = out.dataset.reset;
    if (!L || L.adjust[key] === 0) return;
    const before = { ...L.adjust };
    L.adjust[key] = 0;
    applyAdjust(L);
    commitAdjust(L, before);
  });
}

// ---------------------------------------------------------------------------
// Layers panel
// ---------------------------------------------------------------------------
const ICON = {
  eye: '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 5.1A10.7 10.7 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a10 10 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>',
  save: '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M4 20h16"/></svg>',
  del: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
};

function drawThumb(c, L) {
  const s = 48 * Math.min(2, window.devicePixelRatio || 1);
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  const k = Math.min(s / L.w, s / L.h);
  const w = L.w * k, h = L.h * k;
  ctx.translate(s / 2, s / 2);
  if (L.flip) ctx.scale(-1, 1);
  ctx.globalAlpha = L.opacity;
  ctx.drawImage(L.canvas, -w / 2, -h / 2, w, h);
}

function iconBtn(icon, title, onClick, { disabled = false, cls = '' } = {}) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `ibtn ${cls}`;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.innerHTML = icon;
  b.disabled = disabled;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function renderLayerList() {
  const list = $('layerList');
  list.textContent = '';
  $('layersEmpty').hidden = state.layers.length > 0;
  const n = state.layers.length;
  for (let i = n - 1; i >= 0; i--) {
    const L = state.layers[i];
    const li = document.createElement('li');
    li.className = 'layer';
    if (L.id === state.activeId) li.classList.add('active');
    if (!L.visible) li.classList.add('hidden-layer');
    li.setAttribute('aria-current', L.id === state.activeId ? 'true' : 'false');
    const thumb = document.createElement('canvas');
    thumb.className = 'thumb';
    drawThumb(thumb, L);
    const name = document.createElement('div');
    name.className = 'lname';
    name.textContent = L.name;
    const small = document.createElement('small');
    small.textContent = `${L.w} × ${L.h}${i === n - 1 ? ' · top' : i === 0 ? ' · bottom' : ''}`;
    name.appendChild(small);
    const btns = document.createElement('div');
    btns.className = 'lbtns';
    btns.append(
      iconBtn(L.visible ? ICON.eye : ICON.eyeOff, L.visible ? 'Hide layer' : 'Show layer', () => toggleVisible(L)),
      iconBtn(ICON.up, 'Move up', () => moveLayer(L, +1), { disabled: i === n - 1 }),
      iconBtn(ICON.down, 'Move down', () => moveLayer(L, -1), { disabled: i === 0 }),
      iconBtn(ICON.save, 'Export layer as PNG', () => exportLayer(L)),
      iconBtn(ICON.del, 'Delete layer', () => deleteLayer(L), { cls: 'danger' }),
    );
    li.append(thumb, name, btns);
    li.addEventListener('click', () => setActive(L.id));
    list.appendChild(li);
  }
}

function openLayers() {
  cancelGestures();
  $('layersPanel').hidden = false;
  renderLayerList();
}
function closeLayers() {
  $('layersPanel').hidden = true;
}
$('btnLayers').addEventListener('click', openLayers);
$('btnCloseLayers').addEventListener('click', closeLayers);
$('layersPanel').addEventListener('click', (e) => {
  if (e.target === $('layersPanel')) closeLayers();
});

// ---------------------------------------------------------------------------
// Canvas interaction
// ---------------------------------------------------------------------------
const pointers = new Map(); // id → {x, y, type}
let gesture = null;         // move/zoom/rotate transform gesture
let stroke = null;          // { s: Stroke, id }

function localPoint(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function rotationHandle(L) {
  // Small grip below the middle of the layer's bottom edge (in local +y direction).
  const [ex, ey] = worldToScreen(...layerToWorld(L, 0, L.h / 2));
  const [cx, cy] = worldToScreen(L.x, L.y);
  let dx = ex - cx, dy = ey - cy;
  let len = Math.hypot(dx, dy);
  if (len < 1e-6) { dx = 0; dy = 1; len = 1; }
  return { ex, ey, hx: ex + (dx / len) * 28, hy: ey + (dy / len) * 28 };
}

function showsHandle() {
  return state.tool === 'move' && !state.mobile && !!activeLayer();
}

function snapshotPointers() {
  const m = new Map();
  for (const [id, p] of pointers) m.set(id, { x: p.x, y: p.y });
  return m;
}

function beginGesture(kind, L) {
  if (!gesture) gesture = { kind, L, before: L ? getTransform(L) : null };
  gesture.prev = snapshotPointers();
}

function endGesture() {
  if (!gesture) return;
  const g = gesture;
  gesture = null;
  stage.classList.remove('rotating');
  if (g.L && g.before) commitTransform(g.L, g.before);
  updateUI();
}

function cancelGestures() {
  if (stroke) finishStroke();
  endGesture();
  pointers.clear();
}

function applyGesture() {
  const g = gesture;
  const ids = [...pointers.keys()].filter((id) => g.prev.has(id)).slice(0, 2);
  if (!ids.length) return;
  const v = state.view;
  if (ids.length === 1) {
    const a = g.prev.get(ids[0]), b = pointers.get(ids[0]);
    const dx = b.x - a.x, dy = b.y - a.y;
    if (g.kind === 'move') {
      g.L.x += dx / v.zoom;
      g.L.y += dy / v.zoom;
    } else {
      v.panX += dx;
      v.panY += dy;
    }
  } else {
    const a0 = g.prev.get(ids[0]), a1 = g.prev.get(ids[1]);
    const b0 = pointers.get(ids[0]), b1 = pointers.get(ids[1]);
    const c0x = (a0.x + a1.x) / 2, c0y = (a0.y + a1.y) / 2;
    const c1x = (b0.x + b1.x) / 2, c1y = (b0.y + b1.y) / 2;
    const d0 = Math.hypot(a1.x - a0.x, a1.y - a0.y), d1 = Math.hypot(b1.x - b0.x, b1.y - b0.y);
    const s = d0 > 2 ? d1 / d0 : 1;
    if (g.kind === 'move') {
      let da = Math.atan2(b1.y - b0.y, b1.x - b0.x) - Math.atan2(a1.y - a0.y, a1.x - a0.x);
      if (da > Math.PI) da -= 2 * Math.PI;
      if (da < -Math.PI) da += 2 * Math.PI;
      const L = g.L;
      const ns = clamp(L.scale * s, 1e-4, 1e4);
      const k = ns / L.scale;
      const [w0x, w0y] = screenToWorld(c0x, c0y);
      const [w1x, w1y] = screenToWorld(c1x, c1y);
      const rx = L.x - w0x, ry = L.y - w0y;
      const c = Math.cos(da), sn = Math.sin(da);
      L.x = w1x + k * (rx * c - ry * sn);
      L.y = w1y + k * (rx * sn + ry * c);
      L.scale = ns;
      L.rot += da;
    } else {
      const [wx, wy] = screenToWorld(c0x, c0y);
      v.zoom = clamp(v.zoom * s, 0.02, 64);
      v.panX = c1x - view.w / 2 - wx * v.zoom;
      v.panY = c1y - view.h / 2 - wy * v.zoom;
      $('zoomVal').textContent = `${Math.round(v.zoom * 100)}%`;
    }
  }
  g.prev = snapshotPointers();
  requestRender();
}

// --- brush -----------------------------------------------------------------
function setIndicator(p) {
  const off = brushOffset();
  const [fx, fy] = screenToWorld(p.x, p.y);
  const [ex, ey] = screenToWorld(p.x, p.y - off);
  state.indicator = { fx, fy, ex, ey };
}

function strokeTo(p) {
  const L = stroke.s.L;
  const off = brushOffset();
  const [wx, wy] = screenToWorld(p.x, p.y - off);
  const [ix, iy] = worldToImage(L, wx, wy);
  const r = Math.max(0.5, state.brush.size / 2 / (state.view.zoom * L.scale));
  stroke.s.addPoint(ix, iy, r);
  setIndicator(p);
}

function startStroke(e, p) {
  const L = activeLayer();
  if (!L) {
    toast('Import an image first.');
    return;
  }
  if (!L.visible) toast('The active layer is hidden.');
  stroke = { s: new Stroke(L, state.tool, state.brush), id: e.pointerId };
  strokeTo(p);
  requestRender();
}

function finishStroke() {
  if (!stroke) return;
  const { s } = stroke;
  stroke = null;
  const r = s.finish();
  if (!r) return;
  const L = s.L;
  history.push({
    undo() { writeMaskRegion(L, r, r.before); },
    redo() { writeMaskRegion(L, r, r.after); },
  });
}

// --- pointer events ----------------------------------------------------------
canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault();
  try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  const p = localPoint(e);
  pointers.set(e.pointerId, p);
  const tool = state.tool;

  if (tool === 'erase' || tool === 'restore') {
    if (!stroke && pointers.size === 1) startStroke(e, p);
    return;
  }
  if (tool === 'move') {
    const L = activeLayer();
    if (!L) {
      toast('Import an image first.');
      return;
    }
    if (!gesture && showsHandle() && pointers.size === 1) {
      const h = rotationHandle(L);
      if (Math.hypot(p.x - h.hx, p.y - h.hy) <= 16) {
        const [cx, cy] = worldToScreen(L.x, L.y);
        gesture = {
          kind: 'rotate', L, before: getTransform(L),
          a0: Math.atan2(p.y - cy, p.x - cx), r0: L.rot, id: e.pointerId,
        };
        stage.classList.add('rotating');
        return;
      }
    }
    if (gesture && gesture.kind === 'rotate') return;
    beginGesture('move', L);
    return;
  }
  if (tool === 'zoom') beginGesture('zoom', null);
});

canvas.addEventListener('pointermove', (e) => {
  const p = localPoint(e);
  if (!pointers.has(e.pointerId)) {
    // Hover (mouse): let the brush indicator follow the cursor on PC.
    if (e.pointerType === 'mouse' && (state.tool === 'erase' || state.tool === 'restore')) {
      setIndicator(p);
      requestRender();
    }
    return;
  }
  pointers.set(e.pointerId, p);

  if (stroke) {
    if (e.pointerId !== stroke.id) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    if (evs.length > 1) for (const ce of evs) strokeTo(localPoint(ce));
    else strokeTo(p);
    requestRender();
    return;
  }
  if (!gesture) return;
  if (gesture.kind === 'rotate') {
    if (e.pointerId !== gesture.id) return;
    const L = gesture.L;
    const [cx, cy] = worldToScreen(L.x, L.y);
    let rot = gesture.r0 + Math.atan2(p.y - cy, p.x - cx) - gesture.a0;
    if (e.shiftKey) rot = Math.round(rot / (Math.PI / 12)) * (Math.PI / 12);
    L.rot = rot;
    requestRender();
    return;
  }
  applyGesture();
});

function onPointerEnd(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (stroke && e.pointerId === stroke.id) {
    finishStroke();
    requestRender();
    return;
  }
  if (!gesture) return;
  if (gesture.kind === 'rotate') {
    if (e.pointerId === gesture.id) endGesture();
    return;
  }
  if (pointers.size === 0) endGesture();
  else gesture.prev = snapshotPointers(); // re-baseline when a finger lifts
}
canvas.addEventListener('pointerup', onPointerEnd);
canvas.addEventListener('pointercancel', onPointerEnd);
canvas.addEventListener('lostpointercapture', onPointerEnd);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  let dy = e.deltaY || e.deltaX; // Shift+wheel reports deltaX on some systems
  if (e.deltaMode === 1) dy *= 16;
  else if (e.deltaMode === 2) dy *= 400;
  if (!dy) return;
  if (state.tool === 'move') {
    const L = activeLayer();
    if (!L || gesture) return;
    const before = getTransform(L);
    if (e.shiftKey) {
      L.rot += (dy / 100) * (2 * Math.PI / 180); // ≈2° per wheel notch
      commitTransform(L, before, `wheel-rot-${L.id}`);
    } else {
      L.scale = clamp(L.scale * Math.exp(-dy * 0.0015), 1e-4, 1e4);
      commitTransform(L, before, `wheel-scale-${L.id}`);
    }
    requestRender();
  } else if (state.tool === 'zoom') {
    const p = localPoint(e);
    zoomAt(p.x, p.y, Math.exp(-dy * 0.0015));
    $('zoomVal').textContent = `${Math.round(state.view.zoom * 100)}%`;
    requestRender();
  }
}, { passive: false });

// Keep the browser from hijacking gestures while editing.
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => { if (stage.contains(e.target)) e.preventDefault(); });

// Keyboard shortcuts (PC)
window.addEventListener('keydown', (e) => {
  if (!$('cropDialog').hidden) return;
  if (e.key === 'Escape' && !$('layersPanel').hidden) { closeLayers(); return; }
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) history.redo(); else history.undo();
  } else if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    history.redo();
  }
});

window.addEventListener('beforeunload', (e) => {
  if (state.layers.length) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ---------------------------------------------------------------------------
// Overlay (never part of exports)
// ---------------------------------------------------------------------------
function drawOverlay(ctx) {
  const L = activeLayer();
  if (state.tool === 'move' && L) {
    const pts = layerCorners(L).map(([x, y]) => worldToScreen(x, y));
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,.45)';
    ctx.setLineDash([]);
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#3d8bff';
    ctx.setLineDash([7, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
    if (showsHandle()) {
      const h = rotationHandle(L);
      ctx.beginPath();
      ctx.moveTo(h.ex, h.ey);
      ctx.lineTo(h.hx, h.hy);
      ctx.strokeStyle = '#3d8bff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(h.hx, h.hy, 8, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(h.hx, h.hy, 3.5, -Math.PI * 0.9, Math.PI * 0.4);
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  if ((state.tool === 'erase' || state.tool === 'restore') && state.brush.indicator) {
    let fx, fy, ex, ey;
    if (state.indicator) {
      [fx, fy] = worldToScreen(state.indicator.fx, state.indicator.fy);
      [ex, ey] = worldToScreen(state.indicator.ex, state.indicator.ey);
    } else {
      fx = ex = view.w / 2;
      fy = view.h / 2 + brushOffset() / 2;
      ey = fy - brushOffset();
    }
    const r = state.brush.size / 2;
    const ri = r * (state.brush.hardness / 100);
    if (Math.hypot(fx - ex, fy - ey) > 0.5) {
      ctx.beginPath();
      ctx.moveTo(fx, fy);
      ctx.lineTo(ex, ey);
      ctx.strokeStyle = 'rgba(0,0,0,.5)';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    // inner (hard part)
    if (ri > 0.5) {
      ctx.beginPath();
      ctx.arc(ex, ey, ri, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(140,140,140,.95)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    // outer diameter
    ctx.beginPath();
    ctx.arc(ex, ey, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,.45)';
    ctx.lineWidth = 3.5;
    ctx.stroke();
    ctx.strokeStyle = '#2f8cff';
    ctx.lineWidth = 2;
    ctx.stroke();
    // touch / cursor point
    ctx.beginPath();
    ctx.arc(fx, fy, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ff3b30';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
  }
}

initView(canvas, stage);
setOverlay(drawOverlay);
updateUI();

// ---------------------------------------------------------------------------
// Offline support
// ---------------------------------------------------------------------------
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW registration failed', err));
  });
}

// Debug/test hook (no effect on normal use).
window.__layering = { state, history };
