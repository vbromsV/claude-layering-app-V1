// Central application state. Layers are stored bottom → top.
export const state = {
  layers: [],
  activeId: null,
  tool: 'move',
  mobile: false,
  view: { zoom: 1, panX: 0, panY: 0 },
  brush: {
    size: 60,        // diameter in screen pixels
    hardness: 80,    // %
    strength: 100,   // %
    magic: false,
    tolerance: 20,   // %
    indicator: true,
    offset: 0,       // screen px, mobile only
  },
  // Last brush position in world coordinates: finger point (f) and effect point (e).
  indicator: null,
};

export const TOOLS = ['move', 'erase', 'restore', 'zoom', 'adjust'];
export const TOOL_LABEL = { move: 'Move', erase: 'Erase', restore: 'Restore', zoom: 'Zoom', adjust: 'Adjust' };

export function activeLayer() {
  if (state.activeId == null) return null;
  return state.layers.find((l) => l.id === state.activeId) || null;
}

export function brushOffset() {
  return state.mobile ? state.brush.offset : 0;
}
