// Crop selector used both for import and export.
// cropImage({ image, width, height, title, describe, checker }) → Promise<{x,y,w,h} | null>

import { state } from './state.js';

const BLUE = '#2f8cff';
let checkerPattern = null;

function getChecker(ctx) {
  if (checkerPattern) return checkerPattern;
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const g = c.getContext('2d');
  g.fillStyle = '#eceef1'; g.fillRect(0, 0, 16, 16);
  g.fillStyle = '#c9ccd1'; g.fillRect(0, 0, 8, 8); g.fillRect(8, 8, 8, 8);
  checkerPattern = ctx.createPattern(c, 'repeat');
  return checkerPattern;
}

export function cropImage({ image, width: W, height: H, title = 'Crop', describe, checker = false }) {
  const dlg = document.getElementById('cropDialog');
  const canvas = document.getElementById('cropCanvas');
  const titleEl = document.getElementById('cropTitle');
  const info = document.getElementById('cropInfo');
  const btnOk = document.getElementById('cropOk');
  const btnCancel = document.getElementById('cropCancel');
  const btnReset = document.getElementById('cropReset');
  const ctx = canvas.getContext('2d');

  return new Promise((resolve) => {
    let rect = { x: 0, y: 0, w: W, h: H };
    let s = 1, ox = 0, oy = 0, cw = 1, ch = 1, dpr = 1;
    let drag = null;
    const tol = state.mobile ? 28 : 14;

    titleEl.textContent = title;
    dlg.hidden = false;

    const rounded = () => {
      const x0 = Math.round(rect.x), y0 = Math.round(rect.y);
      const x1 = Math.round(rect.x + rect.w), y1 = Math.round(rect.y + rect.h);
      return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
    };

    function layout() {
      const r = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 3);
      cw = Math.max(1, r.width); ch = Math.max(1, r.height);
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
      const pad = state.mobile ? 22 : 28;
      s = Math.min((cw - 2 * pad) / W, (ch - 2 * pad) / H);
      if (!(s > 0)) s = 1;
      ox = (cw - W * s) / 2;
      oy = (ch - H * s) / 2;
      draw();
    }

    function draw() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      if (checker) {
        ctx.fillStyle = getChecker(ctx);
        ctx.fillRect(ox, oy, W * s, H * s);
      }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(image, ox, oy, W * s, H * s);
      const L = ox + rect.x * s, T = oy + rect.y * s, R = L + rect.w * s, B = T + rect.h * s;
      // dim outside
      ctx.fillStyle = 'rgba(0,0,0,.6)';
      ctx.beginPath();
      ctx.rect(ox, oy, W * s, H * s);
      ctx.rect(L, T, R - L, B - T);
      ctx.fill('evenodd');
      // thirds
      ctx.strokeStyle = 'rgba(255,255,255,.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let k = 1; k < 3; k++) {
        ctx.moveTo(L + ((R - L) * k) / 3, T); ctx.lineTo(L + ((R - L) * k) / 3, B);
        ctx.moveTo(L, T + ((B - T) * k) / 3); ctx.lineTo(R, T + ((B - T) * k) / 3);
      }
      ctx.stroke();
      // outline
      ctx.strokeStyle = BLUE;
      ctx.lineWidth = 2;
      ctx.strokeRect(L, T, R - L, B - T);
      // handles
      ctx.fillStyle = BLUE;
      const hs = state.mobile ? 14 : 10, hl = state.mobile ? 26 : 18;
      for (const [x, y] of [[L, T], [R, T], [R, B], [L, B]]) ctx.fillRect(x - hs / 2, y - hs / 2, hs, hs);
      const mx = (L + R) / 2, my = (T + B) / 2;
      ctx.fillRect(mx - hl / 2, T - 3, hl, 6);
      ctx.fillRect(mx - hl / 2, B - 3, hl, 6);
      ctx.fillRect(L - 3, my - hl / 2, 6, hl);
      ctx.fillRect(R - 3, my - hl / 2, 6, hl);
      const rr = rounded();
      info.textContent = describe ? describe(rr) : `${rr.w} × ${rr.h} px`;
    }

    function hit(px, py) {
      const L = ox + rect.x * s, T = oy + rect.y * s, R = L + rect.w * s, B = T + rect.h * s;
      const nearL = Math.abs(px - L) < tol, nearR = Math.abs(px - R) < tol;
      const nearT = Math.abs(py - T) < tol, nearB = Math.abs(py - B) < tol;
      const inX = px > L - tol && px < R + tol, inY = py > T - tol && py < B + tol;
      // Corners first. With a tiny rect, prefer the corner closest to the pointer.
      if ((nearL || nearR) && (nearT || nearB)) {
        const h = Math.abs(py - T) <= Math.abs(py - B) ? 'n' : 's';
        const v = Math.abs(px - L) <= Math.abs(px - R) ? 'w' : 'e';
        return h + v;
      }
      if (inX && nearT) return 'n';
      if (inX && nearB) return 's';
      if (inY && nearL) return 'w';
      if (inY && nearR) return 'e';
      if (px > L && px < R && py > T && py < B) return 'move';
      return null;
    }

    const pt = (e) => {
      const r = canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };

    function onDown(e) {
      if (drag) return;
      const [px, py] = pt(e);
      const mode = hit(px, py);
      if (!mode) return;
      canvas.setPointerCapture(e.pointerId);
      drag = { id: e.pointerId, mode, px, py, r0: { ...rect } };
      e.preventDefault();
    }
    function onMove(e) {
      const [px, py] = pt(e);
      if (!drag) {
        if (e.pointerType === 'mouse') {
          const m = hit(px, py);
          const cur = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', move: 'move' };
          canvas.style.cursor = cur[m] || 'default';
        }
        return;
      }
      if (e.pointerId !== drag.id) return;
      const dx = (px - drag.px) / s, dy = (py - drag.py) / s;
      const r0 = drag.r0, m = drag.mode;
      const min = Math.min(Math.max(1, 16 / s), W, H);
      if (m === 'move') {
        rect.x = Math.min(Math.max(0, r0.x + dx), W - r0.w);
        rect.y = Math.min(Math.max(0, r0.y + dy), H - r0.h);
      } else {
        let x0 = r0.x, y0 = r0.y, x1 = r0.x + r0.w, y1 = r0.y + r0.h;
        if (m.includes('w')) x0 = Math.min(Math.max(0, r0.x + dx), x1 - min);
        if (m.includes('e')) x1 = Math.max(Math.min(W, x1 + dx), x0 + min);
        if (m.includes('n')) y0 = Math.min(Math.max(0, r0.y + dy), y1 - min);
        if (m.includes('s')) y1 = Math.max(Math.min(H, y1 + dy), y0 + min);
        rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      }
      draw();
    }
    function onUp(e) {
      if (drag && e.pointerId === drag.id) drag = null;
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
      else if (e.key === 'Enter') { e.preventDefault(); close(rounded()); }
    }

    const ro = new ResizeObserver(layout);
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    window.addEventListener('keydown', onKey, true);
    btnOk.onclick = () => close(rounded());
    btnCancel.onclick = () => close(null);
    btnReset.onclick = () => { rect = { x: 0, y: 0, w: W, h: H }; draw(); };

    function close(result) {
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      window.removeEventListener('keydown', onKey, true);
      btnOk.onclick = btnCancel.onclick = btnReset.onclick = null;
      dlg.hidden = true;
      resolve(result);
    }

    ro.observe(canvas);
    requestAnimationFrame(layout);
  });
}
