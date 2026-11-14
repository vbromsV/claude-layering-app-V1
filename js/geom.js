// Geometry helpers. A layer is drawn as:
//   world = (x, y) + R(rot) · scale · (flip ? -lx : lx, ly)
// where (lx, ly) are image coordinates relative to the image centre.

export function layerToWorld(L, lx, ly) {
  const c = Math.cos(L.rot), s = Math.sin(L.rot);
  const x = (L.flip ? -lx : lx) * L.scale;
  const y = ly * L.scale;
  return [L.x + x * c - y * s, L.y + x * s + y * c];
}

/** World point → image pixel coordinates (0..w, 0..h). */
export function worldToImage(L, wx, wy) {
  const c = Math.cos(L.rot), s = Math.sin(L.rot);
  const dx = wx - L.x, dy = wy - L.y;
  let lx = (dx * c + dy * s) / L.scale;
  const ly = (-dx * s + dy * c) / L.scale;
  if (L.flip) lx = -lx;
  return [lx + L.w / 2, ly + L.h / 2];
}

export function layerCorners(L) {
  const hw = L.w / 2, hh = L.h / 2;
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => layerToWorld(L, x, y));
}

export function boundsOf(layers) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const L of layers) {
    for (const [x, y] of layerCorners(L)) {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  if (!isFinite(x0)) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function getTransform(L) {
  return { x: L.x, y: L.y, scale: L.scale, rot: L.rot, flip: L.flip };
}
export function setTransform(L, t) {
  L.x = t.x; L.y = t.y; L.scale = t.scale; L.rot = t.rot; L.flip = t.flip;
}
export function sameTransform(a, b) {
  return a.x === b.x && a.y === b.y && a.scale === b.scale && a.rot === b.rot && a.flip === b.flip;
}
