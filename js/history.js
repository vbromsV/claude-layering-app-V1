// Undo / Redo stack. Commands are objects with undo() and redo().
// Commands carrying the same `key` within MERGE_MS are merged (e.g. wheel scaling),
// provided they implement merge(next).

const LIMIT = 60;
const MERGE_MS = 700;
const undoStack = [];
const redoStack = [];
let listener = () => {};

export function onChange(fn) { listener = fn; }
export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;

export function push(cmd) {
  const now = performance.now();
  const top = undoStack[undoStack.length - 1];
  if (cmd.key && top && top.key === cmd.key && now - top.time < MERGE_MS && top.merge) {
    top.merge(cmd);
    top.time = now;
  } else {
    cmd.time = now;
    undoStack.push(cmd);
    if (undoStack.length > LIMIT) undoStack.shift();
  }
  redoStack.length = 0;
  listener();
}

export function undo() {
  const c = undoStack.pop();
  if (!c) return;
  c.undo();
  redoStack.push(c);
  listener();
}

export function redo() {
  const c = redoStack.pop();
  if (!c) return;
  c.redo();
  c.time = 0; // never merge into a redone command
  undoStack.push(c);
  listener();
}
