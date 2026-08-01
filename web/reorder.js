// Pure drag-reorder math, split out of predictor.js so it can be unit tested.
//
// Loads as a plain <script> in the browser (sets window.KalphishiReorder) and as a
// CommonJS module under `node --test`. Deliberately not an ES module: predictor.js is
// a classic script, and switching it to type="module" would change script execution
// order relative to the inline bootstrap in index.html.
(function (root) {
  'use strict';

  // Given the on-screen rectangles of the rows, in DOM order, decide which row a
  // pointer at clientY is over and whether the dragged item should land after it.
  // Above the first row lands before it; below the last row lands after it.
  function resolveDropTarget(rects, clientY) {
    if (!rects.length) return null;
    for (let idx = 0; idx < rects.length; idx++) {
      const r = rects[idx];
      if (clientY < r.bottom) {
        return { idx, after: clientY > r.top + (r.bottom - r.top) / 2 };
      }
    }
    return { idx: rects.length - 1, after: true };
  }

  // Index the dragged item should end up at, given where it started. Dropping "after"
  // row N means slot N+1, but removing the item first shifts everything above it down
  // by one — hence the decrement when dragging downward. Returns `from` when the move
  // is a no-op, so callers can skip a pointless re-render.
  function resolveDropIndex(from, target) {
    if (!target) return from;
    let to = target.idx + (target.after ? 1 : 0);
    if (from < to) to--;
    return to;
  }

  // Move one element within an array. Returns a new array; does not mutate the input.
  function moveItem(list, from, to) {
    if (from === to) return list.slice();
    if (from < 0 || from >= list.length) return list.slice();
    const out = list.slice();
    const [moved] = out.splice(from, 1);
    out.splice(Math.max(0, Math.min(to, out.length)), 0, moved);
    return out;
  }

  const api = { resolveDropTarget, resolveDropIndex, moveItem };
  root.KalphishiReorder = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
