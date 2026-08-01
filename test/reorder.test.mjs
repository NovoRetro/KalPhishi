// Drag-reorder index math (web/reorder.js) — the part of the touch-drag rewrite where
// off-by-one errors actually live.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { resolveDropTarget, resolveDropIndex, moveItem } =
  createRequire(import.meta.url)('../web/reorder.js');

// Rows 40px tall stacked from y=100, as getBoundingClientRect would report them.
const rects = (n, top = 100, h = 40) =>
  Array.from({ length: n }, (_, i) => ({ top: top + i * h, bottom: top + (i + 1) * h }));

// Composes the two steps the pointerup handler performs.
const drop = (list, from, clientY) =>
  moveItem(list, from, resolveDropIndex(from, resolveDropTarget(rects(list.length), clientY)));

test('resolveDropTarget: upper half targets the row, lower half targets after it', () => {
  const r = rects(3); // 100-140, 140-180, 180-220
  assert.deepEqual(resolveDropTarget(r, 105), { idx: 0, after: false });
  assert.deepEqual(resolveDropTarget(r, 135), { idx: 0, after: true });
  assert.deepEqual(resolveDropTarget(r, 145), { idx: 1, after: false });
  assert.deepEqual(resolveDropTarget(r, 215), { idx: 2, after: true });
});

test('resolveDropTarget: exact midpoint resolves before, not after', () => {
  // clientY > midpoint is the "after" test, so the midpoint itself must fall before.
  assert.deepEqual(resolveDropTarget(rects(2), 120), { idx: 0, after: false });
});

test('resolveDropTarget: past either end clamps to the nearest row', () => {
  const r = rects(3);
  assert.deepEqual(resolveDropTarget(r, -50), { idx: 0, after: false }, 'above the list');
  assert.deepEqual(resolveDropTarget(r, 9999), { idx: 2, after: true }, 'below the list');
});

test('resolveDropTarget: empty list has no target', () => {
  assert.equal(resolveDropTarget([], 150), null);
});

test('resolveDropIndex: dragging down compensates for the removed row', () => {
  // Drop after row 3 while starting at 0: slot 4, minus 1 for the row about to be removed.
  assert.equal(resolveDropIndex(0, { idx: 3, after: true }), 3);
  assert.equal(resolveDropIndex(0, { idx: 3, after: false }), 2);
});

test('resolveDropIndex: dragging up does not compensate', () => {
  assert.equal(resolveDropIndex(4, { idx: 1, after: false }), 1);
  assert.equal(resolveDropIndex(4, { idx: 1, after: true }), 2);
});

test('resolveDropIndex: dropping onto itself is a no-op', () => {
  assert.equal(resolveDropIndex(2, { idx: 2, after: false }), 2);
  assert.equal(resolveDropIndex(2, { idx: 2, after: true }), 2);
  assert.equal(resolveDropIndex(2, { idx: 1, after: true }), 2, 'after the row above is the same slot');
});

test('resolveDropIndex: no target leaves the item where it was', () => {
  assert.equal(resolveDropIndex(3, null), 3);
});

test('moveItem does not mutate its input', () => {
  const src = ['a', 'b', 'c'];
  const out = moveItem(src, 0, 2);
  assert.deepEqual(src, ['a', 'b', 'c']);
  assert.deepEqual(out, ['b', 'c', 'a']);
});

test('moveItem: out-of-range and no-op moves return an equal copy', () => {
  const src = ['a', 'b', 'c'];
  assert.deepEqual(moveItem(src, 1, 1), src);
  assert.deepEqual(moveItem(src, 9, 0), src);
  assert.deepEqual(moveItem(src, -1, 0), src);
});

test('end-to-end: first song dragged onto the lower half of row 2 lands at index 2', () => {
  // The scenario verified by hand in the browser during the mobile fix.
  const list = ['A', 'B', 'C', 'D'];
  assert.deepEqual(drop(list, 0, 180 + 30), ['B', 'C', 'A', 'D']);
});

test('end-to-end: a later song dragged onto the upper half of row 1 lands at index 1', () => {
  const list = ['A', 'B', 'C', 'D', 'E'];
  assert.deepEqual(drop(list, 4, 140 + 10), ['A', 'E', 'B', 'C', 'D']);
});

test('end-to-end: dragging the last song to the very top', () => {
  const list = ['A', 'B', 'C'];
  assert.deepEqual(drop(list, 2, 100 + 5), ['C', 'A', 'B']);
});

test('end-to-end: dragging the first song past the bottom', () => {
  const list = ['A', 'B', 'C'];
  assert.deepEqual(drop(list, 0, 9999), ['B', 'C', 'A']);
});

test('end-to-end: every position round-trips without losing or duplicating songs', () => {
  const list = ['A', 'B', 'C', 'D', 'E'];
  for (let from = 0; from < list.length; from++) {
    for (let y = 90; y < 320; y += 7) {
      const out = drop(list, from, y);
      assert.equal(out.length, list.length, `length changed dragging ${from} to y=${y}`);
      assert.deepEqual([...out].sort(), [...list].sort(), `contents changed dragging ${from} to y=${y}`);
    }
  }
});
