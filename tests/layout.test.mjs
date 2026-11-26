// Run: node --test tests/layout.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../extension/grid/layout.js';

const f = L.frame;
const row = (...c) => L.container('row', c);
const col = (...c) => L.container('column', c);
const show = (n) => (n === null ? null : n.type === 'frame' ? n.id
  : `${n.type === 'row' ? 'R' : 'C'}[${n.children.map(show).join(',')}]`);
const is = (tree, text) => assert.equal(show(tree), text);

function check(tree) {
  const ids = L.frameIds(tree);
  assert.equal(new Set(ids).size, ids.length, 'duplicate frame');
  assert.ok(ids.length >= 1 && ids.length <= L.MAX_FRAMES, 'frame count');
  (function walk(n) {
    if (n.type === 'frame') return;
    assert.ok(n.children.length >= 2 && n.children.length <= L.MAX_CHILDREN, show(tree));
    assert.equal(n.sizes.length, n.children.length);
    assert.ok(Math.abs(n.sizes.reduce((a, b) => a + b, 0) - 1) < 1e-9, 'sizes sum');
    assert.ok(n.sizes.every((s) => s > 0), 'positive sizes');
    n.children.forEach(walk);
  })(tree);
}

function checkTiling(tree, W = 1600, H = 900) {
  const rects = [...L.computeRects(tree, { x: 0, y: 0, w: W, h: H }).values()];
  for (const r of rects) {
    assert.ok([r.x, r.y, r.w, r.h].every(Number.isInteger), 'whole pixels');
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= W && r.y + r.h <= H, 'inside');
  }
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const [a, b] = [rects[i], rects[j]];
      assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, 'overlap');
    }
  }
}

test('add: vertical 1x3 becomes 1x4', () => {
  is(L.addFrame(col(f('a'), f('b'), f('c')), 'b', 'n'), 'C[a,b,c,n]');
});

test('add: single frame uses the given direction', () => {
  is(L.addFrame(f('a'), 'a', 'n', 'column'), 'C[a,n]');
  is(L.addFrame(f('a'), 'a', 'n', 'row'), 'R[a,n]');
});

test('add: full root wraps, full nested column gets a new neighbour', () => {
  is(L.addFrame(col(f('a'), f('b'), f('c'), f('d')), 'a', 'n'), 'R[C[a,b,c,d],n]');
  is(L.addFrame(row(col(f('a'), f('b'), f('c'), f('d')), f('e')), 'a', 'n'), 'R[C[a,b,c,d],n,e]');
});

test('add: nothing selected goes to the root; 16 is the limit', () => {
  is(L.addFrame(col(f('a'), f('b')), null, 'n'), 'C[a,b,n]');
  const full = L.uniformGrid([...Array(16).keys()].map(String), 4, 4);
  assert.equal(L.addFrame(full, '0', 'n'), null);
});

test('worked examples from the design discussion', () => {
  const start = col(f('a'), f('b'), f('c'), f('d'));
  const spanning = L.moveFrame(start, 'd', null, 'screen-right');
  is(spanning, 'R[C[a,b,c],d]');
  is(L.moveFrame(spanning, 'c', null, 'screen-right'), 'R[C[a,b],C[d,c]]'); // same side: 2x2
  is(L.moveFrame(spanning, 'c', null, 'screen-left'), 'R[c,C[a,b],d]');     // opposite: 1-2-1
});

test('move: beside, nested split, swap', () => {
  is(L.moveFrame(col(f('a'), f('b'), f('c')), 'c', 'a', 'top'), 'C[c,a,b]');
  is(L.moveFrame(col(f('a'), f('b'), f('c')), 'c', 'a', 'left'), 'C[R[c,a],b]');
  is(L.moveFrame(row(col(f('a'), f('b')), f('c')), 'a', 'c', 'center'), 'R[C[c,b],a]');
  is(L.moveFrame(row(f('a'), f('b')), 'a', null, 'screen-right'), 'R[b,a]');
});

test('move: rejected when full, onto itself, unknown, or alone', () => {
  const t = row(col(f('a'), f('b'), f('c'), f('d')), f('e'));
  assert.equal(L.moveFrame(t, 'e', 'a', 'top'), null);
  assert.equal(L.moveFrame(t, 'e', 'e', 'left'), null);
  assert.equal(L.moveFrame(t, 'zzz', 'a', 'left'), null);
  assert.equal(L.moveFrame(f('a'), 'a', null, 'screen-left'), null);
});

test('remove: collapses containers; last frame returns null', () => {
  is(L.removeFrame(row(col(f('a'), f('b')), f('c')), 'b'), 'R[a,c]');
  is(L.removeFrame(row(f('a'), f('b')), 'a'), 'b');
  assert.equal(L.removeFrame(f('a'), 'a'), null);
});

test('remove: collapse never creates more than 4 children', () => {
  const t = row(f('p'), col(row(f('q'), f('r'), f('s'), f('t')), f('u')), f('v'), f('w'));
  const out = L.removeFrame(t, 'u');
  check(out);
  assert.equal(L.frameIds(out).length, 7);
});

test('uniform grids: all 16 shapes, reading order preserved', () => {
  for (let r = 1; r <= 4; r++) {
    for (let c = 1; c <= 4; c++) {
      const ids = Array.from({ length: r * c }, (_, i) => `f${i}`);
      const t = L.uniformGrid(ids, r, c);
      check(t);
      checkTiling(t);
      assert.deepEqual(L.readingOrder(t), ids, `${r}x${c}`);
      const rects = [...L.computeRects(t, { x: 0, y: 0, w: 1920, h: 1080 }).values()];
      assert.equal(new Set(rects.map((q) => q.x)).size, c);
      assert.equal(new Set(rects.map((q) => q.y)).size, r);
    }
  }
  assert.equal(L.uniformGrid(['a'], 2, 2), null);
});

test('gaps are exactly 1px at awkward sizes', () => {
  const rects = [...L.computeRects(row(f('a'), f('b'), f('c')), { x: 0, y: 0, w: 1001, h: 500 }).values()];
  assert.equal(rects[1].x - (rects[0].x + rects[0].w), 1);
  assert.equal(rects[2].x - (rects[1].x + rects[1].w), 1);
  assert.equal(rects[2].x + rects[2].w, 1001);
});

test('resize: moves the divider and stops at the minimum', () => {
  const t = row(f('a'), f('b'));
  const r = (tree) => L.computeRects(tree, { x: 0, y: 0, w: 1001, h: 500 });
  assert.equal(r(L.resize(t, [], 0, 100, 1001)).get('a').w, 600);
  assert.equal(r(L.resize(t, [], 0, -9999, 1001)).get('a').w, L.MIN_W);
  assert.equal(r(L.resize(t, [], 0, 9999, 1001)).get('b').w, L.MIN_W);
  const nested = row(f('a'), col(row(f('b'), f('c')), f('d')));
  assert.equal(r(L.resize(nested, [], 0, 9999, 1001)).get('d').w, 2 * L.MIN_W + 1);
});

test('resize: an already too-small pane is not forced larger', () => {
  const t = L.container('row', [f('a'), f('b')], [0.05, 0.95]);
  const out = L.resize(t, [], 0, -50, 1001);
  assert.ok(Math.abs(out.sizes[0] - 0.05) < 1e-9);
});

test('serialize round-trips; bad data is rejected', () => {
  const t = L.resize(row(col(f('a'), f('b')), f('c')), [], 0, 150, 1001);
  const urls = { a: 'https://a.test/', b: null, c: 'https://c.test/' };
  const data = JSON.parse(JSON.stringify(L.serialize(t, (id) => urls[id])));
  let n = 0;
  const back = L.deserialize(data, () => `x${n++}`);
  is(back.tree, 'R[C[x0,x1],x2]');
  assert.deepEqual([...back.urls.values()], ['https://a.test/', null, 'https://c.test/']);
  assert.ok(Math.abs(back.tree.sizes[0] - t.sizes[0]) < 1e-9);
  const bad = [null, {}, { type: 'row', children: [], sizes: [] },
    { type: 'frame', url: 'javascript:alert(1)' },
    { type: 'row', children: [{ type: 'frame' }, { type: 'frame' }], sizes: [1, -1] },
    { type: 'row', children: Array(5).fill({ type: 'frame' }), sizes: Array(5).fill(0.2) }];
  for (const b of bad) assert.equal(L.deserialize(b, () => 'x'), null, JSON.stringify(b));
});

test('fuzz: 20,000 random operations keep every rule', () => {
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor((seed / 2147483648) * n); };
  const zones = ['left', 'right', 'top', 'bottom', 'center', 'screen-left', 'screen-right', 'screen-top', 'screen-bottom'];
  let tree = f('0');
  let next = 1;
  for (let i = 0; i < 20000; i++) {
    const ids = L.frameIds(tree);
    const pick = () => ids[rnd(ids.length)];
    const before = JSON.stringify(tree);
    const op = rnd(10);
    let out;
    let expected = ids.length;
    if (op < 3) { out = L.addFrame(tree, pick(), String(next++), rnd(2) ? 'row' : 'column'); expected++; }
    else if (op < 5) { out = L.removeFrame(tree, pick()); expected--; }
    else if (op < 9) out = L.moveFrame(tree, pick(), pick(), zones[rnd(zones.length)]);
    else if (tree.type !== 'frame') out = L.resize(tree, [], rnd(tree.children.length - 1), rnd(800) - 400, 1600);
    assert.equal(JSON.stringify(tree), before, 'input mutated');
    if (!out) continue;
    check(out);
    assert.equal(L.frameIds(out).length, expected, 'frames lost or gained');
    checkTiling(out, 6000, 6000);
    tree = out;
  }
});

test('dividers: sit exactly in the gaps, and resizing one moves it by the drag distance', () => {
  const rect = { x: 0, y: 0, w: 1601, h: 901 };
  const tree = row(col(f('a'), f('b')), f('c'), col(f('d'), row(f('e'), f('g'))));
  const list = L.computeDividers(tree, rect);
  assert.equal(list.length, 5);
  const frames = [...L.computeRects(tree, rect).values()];
  for (const d of list) {
    assert.equal(d.type === 'row' ? d.w : d.h, L.GAP);
    for (const r of frames) {
      const apart = r.x + r.w <= d.x || d.x + d.w <= r.x || r.y + r.h <= d.y || d.y + d.h <= r.y;
      assert.ok(apart, 'divider overlaps a frame');
    }
    const after = L.computeDividers(L.resize(tree, d.path, d.index, 30, d.length), rect)
      .find((x) => x.index === d.index && x.path.join() === d.path.join());
    const moved = d.type === 'row' ? after.x - d.x : after.y - d.y;
    assert.ok(Math.abs(moved - 30) <= 1, `moved ${moved}`);
  }
  assert.deepEqual(L.computeDividers(f('a'), rect), []);
});

test('equalize resets only that container', () => {
  const tree = L.resize(L.resize(row(col(f('a'), f('b')), f('c')), [], 0, 200, 1601), [0], 0, 100, 901);
  const out = L.equalize(tree, []);
  assert.deepEqual(out.sizes, [0.5, 0.5]);
  assert.deepEqual(out.children[0].sizes, tree.children[0].sizes);
});
