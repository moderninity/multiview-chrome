// Layout tree: pure functions, no DOM. Trees are never mutated.
//   frame:     { type: 'frame', id }
//   container: { type: 'row' | 'column', children: [...], sizes: [...] }  (sizes sum to 1)
// Operations that would break a limit return null.

export const MAX_FRAMES = 16;
export const MAX_CHILDREN = 4;
export const MIN_W = 120;
export const MIN_H = 90;
export const GAP = 1;

export const frame = (id) => ({ type: 'frame', id });
const isFrame = (n) => n.type === 'frame';
const perp = (type) => (type === 'row' ? 'column' : 'row');
const equal = (n) => Array(n).fill(1 / n);

export function container(type, children, sizes = equal(children.length)) {
  const total = sizes.reduce((a, b) => a + b, 0);
  return { type, children, sizes: sizes.map((s) => s / total) };
}

export function frameIds(node) {
  return isFrame(node) ? [node.id] : node.children.flatMap(frameIds);
}

/** Path (child indexes from the root) to a frame, or null. */
export function findPath(node, id, path = []) {
  if (isFrame(node)) return node.id === id ? path : null;
  for (let i = 0; i < node.children.length; i++) {
    const p = findPath(node.children[i], id, [...path, i]);
    if (p) return p;
  }
  return null;
}

export const nodeAt = (node, path) => path.reduce((n, i) => n.children[i], node);

function replaceAt(node, path, next) {
  if (!path.length) return next;
  const [i, ...rest] = path;
  const children = node.children.slice();
  children[i] = replaceAt(children[i], rest, next);
  return { ...node, children };
}

/** Unwrap single-child containers; merge same-direction nesting where it fits. */
function normalize(node) {
  if (isFrame(node)) return node;
  const kids = node.children.map(normalize);
  if (kids.length === 1) return kids[0];
  let count = kids.length;
  const children = [];
  const sizes = [];
  kids.forEach((k, i) => {
    if (k.type === node.type && count - 1 + k.children.length <= MAX_CHILDREN) {
      count += k.children.length - 1;
      k.children.forEach((c, j) => { children.push(c); sizes.push(node.sizes[i] * k.sizes[j]); });
    } else {
      children.push(k);
      sizes.push(node.sizes[i]);
    }
  });
  return container(node.type, children, sizes);
}

/** Insert beside child `index`; the two share that child's space. */
function insertBeside(node, index, child, after) {
  const children = node.children.slice();
  const sizes = node.sizes.slice();
  sizes[index] /= 2;
  children.splice(index + (after ? 1 : 0), 0, child);
  sizes.splice(index, 0, sizes[index]);
  return container(node.type, children, sizes);
}

/** Insert at a position with an equal share; the others shrink in proportion. */
function insertShare(node, index, child) {
  const n = node.children.length;
  const children = node.children.slice();
  const sizes = node.sizes.map((s) => (s * n) / (n + 1));
  children.splice(index, 0, child);
  sizes.splice(index, 0, 1 / (n + 1));
  return container(node.type, children, sizes);
}

/**
 * Add a frame to the selected frame's container. `direction` is only used when
 * there is a single frame and therefore no container yet.
 */
export function addFrame(tree, selectedId, newId, direction = 'row') {
  if (frameIds(tree).length >= MAX_FRAMES) return null;
  const child = frame(newId);
  if (isFrame(tree)) return container(direction, [tree, child]);

  const selPath = findPath(tree, selectedId);
  const path = selPath ? selPath.slice(0, -1) : [];
  const box = nodeAt(tree, path);
  if (box.children.length < MAX_CHILDREN) {
    return replaceAt(tree, path, insertShare(box, box.children.length, child));
  }
  if (!path.length) return container(perp(tree.type), [tree, child]);
  const upPath = path.slice(0, -1);
  const up = nodeAt(tree, upPath);
  if (up.type !== box.type && up.children.length < MAX_CHILDREN) {
    return replaceAt(tree, upPath, insertShare(up, path.at(-1) + 1, child));
  }
  // Everything around is full: split the selected frame itself.
  return replaceAt(tree, selPath, container(perp(box.type), [nodeAt(tree, selPath), child]));
}

/** Remove a frame. Returns null if it was the last one. */
export function removeFrame(tree, id) {
  const path = findPath(tree, id);
  if (!path) return tree;
  if (!path.length) return null;
  const parentPath = path.slice(0, -1);
  const parent = nodeAt(tree, parentPath);
  const keep = (_, i) => i !== path.at(-1);
  return normalize(replaceAt(tree, parentPath,
    container(parent.type, parent.children.filter(keep), parent.sizes.filter(keep))));
}

const ZONES = {
  left: ['row', false], right: ['row', true], top: ['column', false], bottom: ['column', true],
};

/**
 * Move a frame. zone: left | right | top | bottom | center (relative to targetId)
 * or screen-left | screen-right | screen-top | screen-bottom.
 */
export function moveFrame(tree, id, targetId, zone) {
  if (!findPath(tree, id)) return null;
  if (zone.startsWith('screen-')) return moveToEdge(tree, id, zone.slice(7));
  if (id === targetId || !findPath(tree, targetId)) return null;
  if (zone === 'center') {
    const swap = (n) => (isFrame(n)
      ? (n.id === id ? frame(targetId) : n.id === targetId ? frame(id) : n)
      : { ...n, children: n.children.map(swap) });
    return swap(tree);
  }
  if (!ZONES[zone]) return null;
  const [type, after] = ZONES[zone];
  const rest = removeFrame(tree, id);
  const path = findPath(rest, targetId);
  if (path.length) {
    const parentPath = path.slice(0, -1);
    const parent = nodeAt(rest, parentPath);
    if (parent.type === type) {
      if (parent.children.length >= MAX_CHILDREN) return null;
      return replaceAt(rest, parentPath, insertBeside(parent, path.at(-1), frame(id), after));
    }
  }
  const pair = after ? [frame(targetId), frame(id)] : [frame(id), frame(targetId)];
  return replaceAt(rest, path, container(type, pair));
}

/**
 * Drop on a screen edge: makes a new full-length strip there, unless the strip
 * already on that edge is a lone frame, in which case the two share it.
 */
function moveToEdge(tree, id, edge) {
  if (!ZONES[edge]) return null;
  const [type, after] = ZONES[edge];
  const rest = removeFrame(tree, id);
  if (!rest) return null; // only one frame
  if (rest.type === type) {
    const i = after ? rest.children.length - 1 : 0;
    if (isFrame(rest.children[i])) {
      return replaceAt(rest, [i], container(perp(type), [rest.children[i], frame(id)]));
    }
    if (rest.children.length >= MAX_CHILDREN) return null;
    return insertShare(rest, after ? rest.children.length : 0, frame(id));
  }
  return container(type, after ? [rest, frame(id)] : [frame(id), rest]);
}

/** Uniform rows x cols grid; ids are in reading order. */
export function uniformGrid(ids, rows, cols) {
  if (ids.length !== rows * cols || rows > MAX_CHILDREN || cols > MAX_CHILDREN) return null;
  const columns = Array.from({ length: cols }, (_, c) => container('column',
    Array.from({ length: rows }, (_, r) => frame(ids[r * cols + c]))));
  return normalize(container('row', columns));
}

/** Smallest pixel size a subtree may have. */
export function minSize(node) {
  if (isFrame(node)) return { w: MIN_W, h: MIN_H };
  const kids = node.children.map(minSize);
  const gaps = GAP * (kids.length - 1);
  const sum = (k) => kids.reduce((a, m) => a + m[k], 0) + gaps;
  const max = (k) => Math.max(...kids.map((m) => m[k]));
  return node.type === 'row' ? { w: sum('w'), h: max('h') } : { w: max('w'), h: sum('h') };
}

/** Move divider `index` of the container at `path` by deltaPx; lengthPx is the container's length. */
export function resize(tree, path, index, deltaPx, lengthPx) {
  const box = nodeAt(tree, path);
  const usable = lengthPx - GAP * (box.children.length - 1);
  const key = box.type === 'row' ? 'w' : 'h';
  const a = box.sizes[index] * usable;
  const b = box.sizes[index + 1] * usable;
  const minA = Math.min(a, minSize(box.children[index])[key]);
  const minB = Math.min(b, minSize(box.children[index + 1])[key]);
  const d = Math.max(minA - a, Math.min(b - minB, deltaPx));
  const sizes = box.sizes.slice();
  sizes[index] = (a + d) / usable;
  sizes[index + 1] = (b - d) / usable;
  return replaceAt(tree, path, container(box.type, box.children, sizes));
}

/** Pixel rectangles: Map(id -> {x, y, w, h}), whole pixels with exact gaps. */
export function computeRects(node, rect, out = new Map()) {
  if (isFrame(node)) { out.set(node.id, rect); return out; }
  const row = node.type === 'row';
  const n = node.children.length;
  const usable = (row ? rect.w : rect.h) - GAP * (n - 1);
  let acc = 0;
  let start = 0;
  node.children.forEach((child, i) => {
    acc += node.sizes[i];
    const end = i === n - 1 ? usable : Math.round(acc * usable);
    const offset = start + GAP * i;
    computeRects(child, row
      ? { x: rect.x + offset, y: rect.y, w: end - start, h: rect.h }
      : { x: rect.x, y: rect.y + offset, w: rect.w, h: end - start }, out);
    start = end;
  });
  return out;
}

/**
 * Every divider: [{ path, index, type, length, x, y, w, h }]. path/index/length are
 * what resize() takes; the rectangle is the 1px gap itself.
 */
export function computeDividers(node, rect, path = [], out = []) {
  if (isFrame(node)) return out;
  const row = node.type === 'row';
  const length = row ? rect.w : rect.h;
  const n = node.children.length;
  const usable = length - GAP * (n - 1);
  let acc = 0;
  let start = 0;
  node.children.forEach((child, i) => {
    acc += node.sizes[i];
    const end = i === n - 1 ? usable : Math.round(acc * usable);
    const offset = start + GAP * i;
    computeDividers(child, row
      ? { x: rect.x + offset, y: rect.y, w: end - start, h: rect.h }
      : { x: rect.x, y: rect.y + offset, w: rect.w, h: end - start }, [...path, i], out);
    if (i < n - 1) {
      const at = end + GAP * i;
      out.push({ path, index: i, type: node.type, length, ...(row
        ? { x: rect.x + at, y: rect.y, w: GAP, h: rect.h }
        : { x: rect.x, y: rect.y + at, w: rect.w, h: GAP }) });
    }
    start = end;
  });
  return out;
}

/** Give a container's children equal sizes. */
export const equalize = (tree, path) => {
  const box = nodeAt(tree, path);
  return replaceAt(tree, path, container(box.type, box.children));
};

/** Frame ids top-to-bottom, then left-to-right. */
export function readingOrder(tree) {
  return [...computeRects(tree, { x: 0, y: 0, w: 16000, h: 16000 })]
    .sort(([, a], [, b]) => a.y - b.y || a.x - b.x).map(([id]) => id);
}

export function serialize(node, urlOf) {
  if (isFrame(node)) return { type: 'frame', url: urlOf(node.id) ?? null };
  return { type: node.type, sizes: node.sizes, children: node.children.map((c) => serialize(c, urlOf)) };
}

/** Returns { tree, urls: Map(id -> url|null) }, or null if the data isn't a valid layout. */
export function deserialize(data, newId) {
  const urls = new Map();
  const read = (d) => {
    if (d?.type === 'frame') {
      if (d.url != null && !/^https?:\/\//i.test(d.url)) throw new Error('bad url');
      if (urls.size >= MAX_FRAMES) throw new Error('too many frames');
      const id = newId();
      urls.set(id, d.url ?? null);
      return frame(id);
    }
    const ok = (d?.type === 'row' || d?.type === 'column')
      && Array.isArray(d.children) && Array.isArray(d.sizes)
      && d.children.length >= 2 && d.children.length <= MAX_CHILDREN
      && d.sizes.length === d.children.length
      && d.sizes.every((s) => Number.isFinite(s) && s > 0);
    if (!ok) throw new Error('bad container');
    return container(d.type, d.children.map(read), d.sizes);
  };
  try { return { tree: normalize(read(data)), urls }; } catch { return null; }
}
