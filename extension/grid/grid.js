import * as Layout from './layout.js';
import * as Store from './store.js';
import { parseAddress } from './address.js';
import { addPopup, closePopups, introduceBar, isTextInput, pointerInFrame, popupOpen } from './bar.js';
import { initMenu } from './menu.js';
import { draggable } from './drag.js';

const CORNER_HIDE_MS = 400;
const CRASH_WAIT_MS = 1500;
const LEAVE_GUARD_MS = 2000;
const EDGE_BAND_PX = 24; // dropping this close to the grid's edge means "whole edge"
const ALLOW = 'autoplay; encrypted-media; picture-in-picture; clipboard-read; clipboard-write';
const FOCUS_GRACE_MS = 120;

const $ = (id) => document.getElementById(id);
const gridEl = $('grid');
const gridId = crypto.randomUUID().slice(0, 8);
const cells = new Map();          // cellId -> state
const topFrameToCell = new Map(); // browser frameId of a cell's top frame -> cellId
const frameToCell = new Map();    // any browser frameId -> cellId (cache)

let myTabId = null;
let settings = Store.DEFAULTS;
let tree = null;
let selected = null;
let nextId = 1;
let idleTimer = null;
let lastActive = null;
let lastInteract = 0;
let lastTab = 0;
let lastOwnMove = 0; // Date.now() of the last pointer move over our own UI

const log = (...parts) => console.log('[MV]', ...parts);

async function init() {
  myTabId = (await chrome.tabs.getCurrent()).id;
  const res = await chrome.runtime.sendMessage({ type: 'mv:register' });
  if (!res?.ok) log('header rule failed:', res?.error);
  await applySettings();
  Store.onChange({ settings: applySettings });
  buildPicker();
  initMenu({ captureLayout, loadLayout, loadedCount, loadIntoSelectedBlank, loadIntoBlank, blankAt, markDrop });
  const id = makeCell();
  tree = Layout.frame(id);
  select(id);
  new ResizeObserver(render).observe(gridEl);
  render();
  introduceBar();
  cells.get(id).input.focus();
  // Links sent before this grid tab existed.
  const { pendingOpen = [] } = await chrome.storage.session.get('pendingOpen');
  await chrome.storage.session.remove('pendingOpen');
  for (const url of pendingOpen) openLink(url);
}

async function applySettings() {
  settings = await Store.getSettings();
  document.body.dataset.edge = settings.edge;
  document.body.dataset.autohide = settings.autoHide;
  document.documentElement.style.setProperty('--accent', settings.accent);
  if (selected) activity();
}

// ---- cells ----
// A cell's element is created once and never re-parented or re-ordered: moving
// an iframe in the DOM reloads it. Layout only changes left/top/width/height.

const newId = () => `f${nextId++}`;

function makeCell(id = newId()) {
  const el = document.createElement('div');
  el.className = 'cell';
  el.dataset.cell = id;

  const blank = document.createElement('form');
  blank.className = 'blank';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Enter a web address';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Web address');
  const error = document.createElement('div');
  error.className = 'error';
  error.setAttribute('role', 'alert');
  blank.append(input, error);
  blank.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!navigate(id, input.value)) error.textContent = 'Not a valid address';
  });
  input.addEventListener('input', () => { error.textContent = ''; });

  const outline = document.createElement('div');
  outline.className = 'outline';

  // Corner X. bridge.js reports the pointer near the corner; the strip is for
  // pages where it can't run. Blank frames are ours, so plain hover works.
  // pointermove rather than pointerenter: see bar.js.
  const strip = document.createElement('div');
  strip.className = 'strip';
  const corner = document.createElement('div');
  corner.className = 'corner';
  const x = document.createElement('button');
  x.textContent = '✕';
  x.title = 'Close frame';
  x.tabIndex = -1; // keyboard users have Close frame in the bar
  x.addEventListener('click', () => closeFrame(id));
  const grip = document.createElement('button');
  grip.className = 'grip';
  grip.textContent = '⠿';
  grip.title = 'Drag to move';
  grip.tabIndex = -1;
  corner.append(grip, x);
  draggable(grip, moveDrag(id));
  draggable(blank, { ...moveDrag(id), accepts: (e) => e.target !== input });
  for (const hot of [strip, corner]) {
    hot.addEventListener('pointermove', () => { cells.get(id).onCorner = true; showCorner(id); });
    hot.addEventListener('pointerleave', () => {
      if (!cells.has(id)) return;
      cells.get(id).onCorner = false;
      hideCorner(id);
    });
  }
  el.addEventListener('pointermove', () => {
    const s = cells.get(id);
    if (s.iframe) return;
    s.onCorner = true;
    showCorner(id);
  });
  el.addEventListener('pointerleave', () => {
    if (!cells.has(id)) return;
    cells.get(id).onCorner = false;
    hideCorner(id);
  });

  el.append(blank, strip, corner, outline);
  el.addEventListener('pointerdown', () => { select(id); activity(); });
  gridEl.append(el);

  cells.set(id, {
    el, blank, input, iframe: null, frameId: null, script: false, hellos: 0, port: null, commitAt: 0, crashed: null,
    url: null, historyUrl: null, fs: false, volume: 1, muted: false, zoom: 1,
    onCorner: false, cornerTimer: null,
  });
  return id;
}

/** Loads typed text into a cell. Returns false if it isn't an address. */
function navigate(id, text) {
  const url = parseAddress(text);
  if (!url) return false;
  const s = cells.get(id);
  s.url = url;
  clearCrash(s);
  if (!s.iframe) {
    s.iframe = document.createElement('iframe');
    s.iframe.name = `mv:${gridId}:${id}`;
    s.iframe.allow = ALLOW; // deliberately no "fullscreen"
    s.iframe.addEventListener('load', () => checkScript(id));
    s.iframe.src = url;
    s.blank.replaceWith(s.iframe);
    s.blank = s.input = null;
    s.onCorner = false;
    setScript(s, false);
  } else {
    s.iframe.src = url;
  }
  if (selected === id) syncBar();
  return true;
}

/** Whether bridge.js is running in this cell. */
function setScript(s, on) {
  s.script = on;
  s.el.classList.toggle('noscript', !on);
}

function showCorner(id) {
  const s = cells.get(id);
  clearTimeout(s.cornerTimer);
  s.el.classList.add('corner-on');
}

function hideCorner(id) {
  const s = cells.get(id);
  if (!s.el.classList.contains('corner-on')) return;
  clearTimeout(s.cornerTimer);
  // The frame's "left the corner" message can arrive after the pointer reached the X.
  s.cornerTimer = setTimeout(() => { if (!s.onCorner) s.el.classList.remove('corner-on'); }, CORNER_HIDE_MS);
}

/** The pointer was seen inside this cell's page, so it isn't over any of our own controls. */
function pointerInCell(cellId, inCorner) {
  pointerInFrame();
  for (const d of dividers) d.el.classList.remove('hot');
  for (const [id, s] of cells) {
    s.onCorner = false;
    if (id !== cellId || !inCorner) hideCorner(id);
  }
}

function destroyCell(id) {
  cells.get(id).el.remove();
  cells.delete(id);
  countCrashes();
  for (const map of [topFrameToCell, frameToCell]) {
    for (const [f, c] of map) if (c === id) map.delete(f);
  }
}

export function newFrame() {
  const r = selected && cells.get(selected).el.getBoundingClientRect();
  const id = newId();
  const next = Layout.addFrame(tree, selected, id, !r || r.width >= r.height ? 'row' : 'column');
  if (!next) return;
  makeCell(id);
  tree = next;
  render();
  select(id);
  activity();
  cells.get(id).input.focus();
  return id;
}

/** Opens a link sent from a page (context menu or Ctrl+Shift+click): a blank frame if there is one, else a new frame. */
function openLink(url) {
  if (!/^https?:/.test(url)) return false;
  const order = Layout.readingOrder(tree);
  const blank = !cells.get(selected)?.iframe ? selected : order.find((id) => !cells.get(id).iframe);
  const id = blank ?? newFrame();
  if (!id) return false;
  select(id);
  activity();
  return navigate(id, url);
}

export function closeFrame(id = selected) {
  if (!id || !cells.has(id)) return;
  let next = Layout.removeFrame(tree, id);
  if (!next) next = Layout.frame(makeCell()); // never empty
  destroyCell(id);
  tree = next;
  if (selected === id) {
    selected = null;
    select(Layout.readingOrder(tree)[0]);
  }
  render();
}

/** Returns false if the move isn't allowed. */
export function move(id, targetId, zone) {
  const next = planMove(id, targetId, zone);
  if (!next) return false;
  tree = next;
  render();
  return true;
}

export function resizeDivider(path, index, deltaPx) {
  const d = Layout.computeDividers(tree, gridRect()).find((x) => x.index === index && x.path.join() === path.join());
  tree = Layout.resize(tree, path, index, deltaPx, d.length);
  render();
}

const loadedCount = () => [...cells.values()].filter((s) => s.iframe).length;

/** Rearranges into rows x cols: adds or drops blank frames, never closes a loaded one. */
export function applyGrid(rows, cols) {
  const want = rows * cols;
  if (loadedCount() > want) return false;
  const ids = Layout.readingOrder(tree);
  for (let i = ids.length - 1; i >= 0 && ids.length > want; i--) {
    if (!cells.get(ids[i]).iframe) destroyCell(ids.splice(i, 1)[0]);
  }
  while (ids.length < want) ids.push(makeCell());
  tree = Layout.uniformGrid(ids, rows, cols);
  if (!cells.has(selected)) { selected = null; select(ids[0]); }
  render();
  return true;
}

// ---- presets and history ----

const captureLayout = () => Layout.serialize(tree, (id) => cells.get(id).url);

/** Replaces everything with a saved layout. Returns false if the data is bad. */
function loadLayout(data) {
  const saved = Layout.deserialize(data, newId);
  if (!saved) return false;
  for (const id of [...cells.keys()]) destroyCell(id);
  for (const id of saved.urls.keys()) makeCell(id);
  tree = saved.tree;
  selected = null;
  select(Layout.readingOrder(tree)[0]);
  activity();
  render();
  for (const [id, url] of saved.urls) if (url) navigate(id, url);
  return true;
}

function loadIntoBlank(id, url) {
  if (!cells.has(id) || cells.get(id).iframe) return false;
  select(id);
  activity();
  return navigate(id, url);
}

const loadIntoSelectedBlank = (url) => loadIntoBlank(selected, url);

/** The blank frame at a point, or null. */
function blankAt(x, y) {
  for (const [id, s] of cells) {
    if (s.iframe) continue;
    const r = s.el.getBoundingClientRect();
    if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) return id;
  }
  return null;
}

function markDrop(dropId) {
  for (const [id, s] of cells) s.el.classList.toggle('drop', id === dropId);
}

function recordHistory(s, url, title) {
  if (s.historyUrl === url) {
    Store.retitleHistory(url, title);
  } else {
    s.historyUrl = url;
    Store.addHistory(url, title);
  }
}

function gridRect() {
  return { x: 0, y: 0, w: gridEl.clientWidth, h: gridEl.clientHeight };
}

function render() {
  for (const [id, r] of Layout.computeRects(tree, gridRect())) {
    Object.assign(cells.get(id).el.style, {
      left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px`,
    });
  }
  renderDividers();
  $('new').disabled = cells.size >= Layout.MAX_FRAMES;
}

// ---- moving frames ----

function tooSmall(t) {
  return [...Layout.computeRects(t, gridRect()).values()]
    .filter((r) => r.w < Layout.MIN_W || r.h < Layout.MIN_H).length;
}

/** The layout after a move, or null if it isn't allowed or changes nothing. */
function planMove(id, targetId, zone) {
  const next = Layout.moveFrame(tree, id, targetId, zone);
  if (!next || JSON.stringify(next) === JSON.stringify(tree)) return null;
  return tooSmall(next) > tooSmall(tree) ? null : next;
}

/** What a drop at this point means: { target, zone, rect }, or null for "nothing". */
function dropAt(id, clientX, clientY) {
  const g = gridRect();
  const o = gridEl.getBoundingClientRect();
  const x = clientX - o.left;
  const y = clientY - o.top;
  // Outside counts as the nearest edge: the pointer can overshoot the window.
  const fromEdge = { left: x, right: g.w - x, top: y, bottom: g.h - y };
  const [edge, distance] = Object.entries(fromEdge).sort((a, b) => a[1] - b[1])[0];
  if (distance < EDGE_BAND_PX) {
    const b = EDGE_BAND_PX;
    const rect = {
      left: { x: 0, y: 0, w: b, h: g.h }, right: { x: g.w - b, y: 0, w: b, h: g.h },
      top: { x: 0, y: 0, w: g.w, h: b }, bottom: { x: 0, y: g.h - b, w: g.w, h: b },
    }[edge];
    return { target: null, zone: `screen-${edge}`, rect };
  }
  for (const [target, rect] of Layout.computeRects(tree, g)) {
    if (x < rect.x || x >= rect.x + rect.w || y < rect.y || y >= rect.y + rect.h) continue;
    if (target === id) return null;
    const fx = (x - rect.x) / rect.w;
    const fy = (y - rect.y) / rect.h;
    const [side, d] = Object.entries({ left: fx, right: 1 - fx, top: fy, bottom: 1 - fy })
      .sort((a, b) => a[1] - b[1])[0];
    return { target, zone: d < 0.25 ? side : 'center', rect };
  }
  return null;
}

/** Outlines of the layout a drop would give, with the moved frame filled in. */
function showPreview(id, drop) {
  const next = drop && planMove(id, drop.target, drop.zone);
  const boxes = !drop ? [] : next
    ? [...Layout.computeRects(next, gridRect())].map(([f, r]) => [r, f === id ? 'moved' : ''])
    : [[drop.rect, 'refused']];
  $('preview').replaceChildren(...boxes.map(([r, cls]) => {
    const el = document.createElement('div');
    el.className = cls;
    Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    return el;
  }));
}

function moveDrag(id) {
  return {
    start: () => { select(id); activity(); },
    move: (e) => showPreview(id, dropAt(id, e.clientX, e.clientY)),
    drop: (e) => {
      const drop = dropAt(id, e.clientX, e.clientY);
      if (drop) move(id, drop.target, drop.zone);
    },
    end: () => { $('preview').replaceChildren(); activity(); },
  };
}

// ---- dividers ----
// Elements are reused by position in the list, so the one being dragged stays
// in place: resizing never changes how many dividers there are.

const HIT_PX = 8;
const dividers = []; // { el, tab, data }

function makeDivider() {
  const el = document.createElement('div');
  el.className = 'divider';
  const tab = document.createElement('div');
  tab.className = 'tab';
  el.append(tab);
  const d = { el, tab, data: null };
  let from = null;

  el.addEventListener('pointermove', (e) => { // not pointerenter: see bar.js
    el.classList.add('hot');
    const r = el.getBoundingClientRect();
    if (d.data.type === 'row') Object.assign(tab.style, { left: '50%', top: `${e.clientY - r.top}px` });
    else Object.assign(tab.style, { left: `${e.clientX - r.left}px`, top: '50%' });
  });
  el.addEventListener('pointerleave', () => el.classList.remove('hot'));
  el.addEventListener('dblclick', () => { tree = Layout.equalize(tree, d.data.path); render(); });

  draggable(el, {
    get cursor() { return d.data.type === 'row' ? 'col-resize' : 'row-resize'; },
    threshold: 1,
    start: (e) => { from = { ...d.data, tree, x: e.clientX, y: e.clientY }; },
    move: (e) => {
      const delta = from.type === 'row' ? e.clientX - from.x : e.clientY - from.y;
      tree = Layout.resize(from.tree, from.path, from.index, delta, from.length);
      render();
      activity();
    },
    end: () => { el.classList.remove('hot'); },
    cancel: () => { tree = from.tree; render(); },
  });
  $('dividers').append(el);
  return d;
}

function renderDividers() {
  const list = Layout.computeDividers(tree, gridRect());
  while (dividers.length < list.length) dividers.push(makeDivider());
  while (dividers.length > list.length) dividers.pop().el.remove();
  list.forEach((data, i) => {
    const d = dividers[i];
    d.data = data;
    const row = data.type === 'row';
    d.el.classList.toggle('vertical', row);
    const pad = (HIT_PX - Layout.GAP) / 2;
    Object.assign(d.el.style, {
      left: `${data.x - (row ? pad : 0)}px`, top: `${data.y - (row ? 0 : pad)}px`,
      width: `${data.w + (row ? pad * 2 : 0)}px`, height: `${data.h + (row ? 0 : pad * 2)}px`,
    });
  });
}

// ---- browser frame -> cell mapping ----

async function getFrames() {
  return (await chrome.webNavigation.getAllFrames({ tabId: myTabId })) ?? [];
}

function topOf(frameId, parents) {
  let f = frameId;
  while (parents.has(f) && parents.get(f) !== 0) f = parents.get(f);
  return f;
}

async function resolveCell(frameId) {
  if (frameToCell.has(frameId)) return frameToCell.get(frameId);
  const parents = new Map((await getFrames()).map((f) => [f.frameId, f.parentFrameId]));
  const cellId = topFrameToCell.get(topOf(frameId, parents)) ?? null;
  if (cellId) frameToCell.set(frameId, cellId);
  return cellId;
}

function sendTo(frameId, msg) {
  chrome.tabs.sendMessage(myTabId, msg, { frameId }).catch(() => {});
}

async function pushToCell(cellId, makeMsg) {
  const frames = await getFrames();
  const parents = new Map(frames.map((f) => [f.frameId, f.parentFrameId]));
  const s = cells.get(cellId);
  if (!s) return;
  for (const { frameId } of frames) {
    if (frameId !== 0 && topFrameToCell.get(topOf(frameId, parents)) === cellId) sendTo(frameId, makeMsg(s));
  }
}

const audioMsg = (s) => ({ type: 'mv:audio', volume: s.volume, muted: s.muted });
const zoomMsg = (s) => ({ type: 'mv:zoom', zoom: s.zoom });
const pushAudio = (cellId) => pushToCell(cellId, audioMsg);
const pushZoom = (cellId) => pushToCell(cellId, zoomMsg);

/** Bring a newly loaded frame up to date with its cell. */
function greet(s, send) {
  if (s.volume !== 1 || s.muted) send(audioMsg(s));
  if (s.zoom !== 1) send(zoomMsg(s));
}

// ---- crashed frames ----
// The browser still lists a crashed frame as normal. What gives it away: its
// connection closes although it didn't go to another page.

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'mv' || port.sender.tab?.id !== myTabId) return;
  const { frameId } = port.sender;
  const connectedAt = Date.now();
  const known = cells.get(topFrameToCell.get(frameId));
  if (known) known.port = port;
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    const cellId = topFrameToCell.get(frameId);
    if (cells.get(cellId)?.port === port) checkCrash(cellId, connectedAt);
  });
});

chrome.webNavigation.onCommitted.addListener(({ tabId, frameId, timeStamp }) => {
  const s = tabId === myTabId && cells.get(topFrameToCell.get(frameId));
  if (s) s.commitAt = timeStamp;
});

async function checkCrash(cellId, connectedAt) {
  const s = cells.get(cellId);
  const { hellos } = s;
  await new Promise((done) => setTimeout(done, CRASH_WAIT_MS));
  if (cells.get(cellId) !== s || s.hellos !== hellos || s.commitAt > connectedAt) return;
  const alive = await chrome.tabs.sendMessage(myTabId, { type: 'mv:ping' }, { frameId: s.frameId }).then(() => true, () => false);
  const errorPage = (await getFrames()).find((f) => f.frameId === s.frameId)?.errorOccurred; // sends no onCommitted
  if (alive || errorPage || cells.get(cellId) !== s || s.hellos !== hellos || s.crashed) return;
  setScript(s, false);
  s.fs = false;
  const panel = document.createElement('div');
  panel.className = 'crashed';
  const text = document.createElement('div');
  text.textContent = 'This page crashed';
  const one = document.createElement('button');
  one.textContent = 'Reload';
  one.addEventListener('click', () => navigate(cellId, s.url));
  const all = document.createElement('button');
  all.className = 'all';
  all.textContent = 'Reload all crashed';
  all.addEventListener('click', () => {
    for (const [id, c] of [...cells]) if (c.crashed) navigate(id, c.url);
  });
  panel.append(text, one, all);
  s.crashed = panel;
  s.iframe.after(panel);
  countCrashes();
  if (cellId === selected) syncBar();
}

function clearCrash(s) {
  s.crashed?.remove();
  s.crashed = null;
  countCrashes();
}

/** "Reload all" only makes sense with several; cells of one site share a process. */
function countCrashes() {
  const n = [...cells.values()].filter((s) => s.crashed).length;
  gridEl.classList.toggle('several-crashed', n > 1);
}

// ---- messages from content scripts ----

chrome.runtime.onMessage.addListener((msg, sender) => {
  // From the service worker, aimed at one grid tab.
  if (msg?.type === 'mv:openLink' && !sender.tab) {
    if (msg.tabId === myTabId) openLink(msg.url);
    return;
  }
  if (sender.tab?.id !== myTabId || !msg?.type?.startsWith('mv:') || !sender.frameId) return;
  handle(msg, sender.frameId);
});

async function handle(msg, frameId) {
  if (msg.type === 'mv:hello' && msg.isCellTop) {
    // Pages can overwrite window.name, so trust a frame we already know.
    const [, grid, named] = msg.name?.split(':') ?? [];
    const cellId = topFrameToCell.get(frameId) ?? (grid === gridId ? named : null);
    const s = cells.get(cellId);
    if (!s) return;
    Object.assign(s, { frameId, hellos: s.hellos + 1, fs: false });
    setScript(s, true);
    clearCrash(s);
    topFrameToCell.set(frameId, cellId);
    frameToCell.set(frameId, cellId);
    greet(s, (m) => sendTo(frameId, m));
    if (cellId === selected) syncBar();
    return;
  }

  if (msg.type === 'mv:interact') lastInteract = performance.now();
  const cellId = await resolveCell(frameId);
  const s = cells.get(cellId);
  if (!s) return;

  switch (msg.type) {
    case 'mv:hello': // nested frame
      greet(s, (m) => sendTo(frameId, m));
      break;
    case 'mv:url':
      if (!/^https?:/.test(msg.url)) break;
      if (pageKey(msg.url) !== pageKey(s.url) && s.zoom !== 1) setZoom(cellId, 1);
      s.url = msg.url;
      recordHistory(s, msg.url, String(msg.title ?? '').slice(0, 200));
      if (cellId === selected) syncBar();
      break;
    case 'mv:interact':
      closePopups();
      select(cellId);
      activity();
      break;
    case 'mv:corner':
      // A nested frame's corner is the cell's corner only while it fills the cell.
      if (!msg.on) hideCorner(cellId);
      else if ((msg.top || s.fs) && msg.at >= lastOwnMove) showCorner(cellId); // not if it's late
      break;
    case 'mv:activity':
      if (msg.pointer && msg.at >= lastOwnMove) pointerInCell(cellId, msg.corner && (msg.top || s.fs));
      if (cellId === selected) activity();
      break;
    case 'mv:open': // a nested frame's link aimed at the top window
      if (/^https?:/.test(msg.url)) navigate(cellId, msg.url);
      break;
    case 'mv:fs':
      s.fs = msg.on;
      if (cellId === selected) syncBar();
      break;
    case 'mv:volume': // user changed volume in the site's own player
      s.volume = msg.volume;
      s.muted = msg.muted;
      pushAudio(cellId);
      if (cellId === selected) syncBar();
      break;
  }
}

// ---- zoom ----

/** Identifies what's playing, ignoring address changes that don't change it. */
function pageKey(url) {
  if (!url) return null;
  const u = new URL(url);
  return [u.host.replace(/^www\./, ''), u.pathname, u.searchParams.get('v')].join(' ');
}

function setZoom(cellId, zoom) {
  cells.get(cellId).zoom = zoom;
  if (cellId === selected) syncBar();
  pushZoom(cellId);
}

// A page the user just clicked can replace the whole tab by script. Nothing can
// block that, so ask first. Only right after a click in a page, so that closing
// the tab normally doesn't ask.
window.addEventListener('beforeunload', (e) => {
  if (lastInteract && performance.now() - lastInteract < LEAVE_GUARD_MS) e.preventDefault();
});

// ---- selection + activity ----

function select(cellId) {
  if (selected === cellId || !cells.has(cellId)) return;
  if (cells.has(selected)) cells.get(selected).el.classList.remove('selected');
  selected = cellId;
  cells.get(cellId).el.classList.add('selected');
  syncBar();
}

function activity() {
  const el = cells.get(selected)?.el;
  if (!el) return;
  el.classList.remove('idle');
  clearTimeout(idleTimer);
  if (!settings.idleSeconds) return; // never fade
  idleTimer = setTimeout(() => el.classList.add('idle'), settings.idleSeconds * 1000);
}

// Clicks are normally reported by bridge.js. Focus is only a fallback for cells
// where it isn't running, because pages also grab focus by themselves (YouTube
// does when a video loads). Checking :hover doesn't help: it goes stale here
// when the pointer enters a cross-site iframe.
function checkFocus() {
  const a = document.activeElement;
  if (a === lastActive) return;
  const previous = lastActive;
  lastActive = a;
  if (a?.tagName !== 'IFRAME') return;
  const cellId = a.closest('.cell').dataset.cell;
  if (cells.get(cellId).script) {
    if (isTextInput(previous)) returnFocus(previous, a);
    return;
  }
  closePopups();
  select(cellId);
  activity();
}

/** A page took focus while the user was typing in one of our inputs: take it back. */
function returnFocus(input, iframe) {
  const at = performance.now();
  setTimeout(() => {
    const userDidIt = lastInteract > at - FOCUS_GRACE_MS || lastTab > at - FOCUS_GRACE_MS;
    if (userDidIt || document.activeElement !== iframe || !input.isConnected) return;
    input.focus();
    lastActive = input;
  }, FOCUS_GRACE_MS);
}

window.addEventListener('blur', () => setTimeout(checkFocus, 0));
document.addEventListener('focusin', checkFocus);
document.addEventListener('pointermove', () => { lastOwnMove = Date.now(); }, true);
setInterval(checkFocus, 300);
document.addEventListener('keydown', (e) => { if (e.key === 'Tab') lastTab = performance.now(); }, true);

// A cell can navigate from a page where bridge.js runs to one where it can't.
async function checkScript(cellId) {
  const s = cells.get(cellId);
  if (!s || s.frameId == null || !s.script) return;
  const { hellos } = s;
  const alive = await chrome.tabs.sendMessage(myTabId, { type: 'mv:ping' }, { frameId: s.frameId })
    .then((r) => r === 'mv:pong', () => false);
  if (alive || s.hellos !== hellos || !cells.has(cellId)) return;
  setScript(s, false);
  // If this cell already holds focus, a click wouldn't change it. Let go.
  if (document.activeElement === s.iframe) s.iframe.blur();
  lastActive = document.activeElement;
}

// ---- bar ----

function syncBar() {
  const s = cells.get(selected);
  const loaded = !!s?.iframe;
  if (document.activeElement !== $('url')) $('url').value = s?.url ?? '';
  $('url').placeholder = loaded ? '' : 'Enter a web address';
  for (const id of ['back', 'fwd', 'reload', 'vol', 'mute']) $(id).disabled = !loaded;
  const v = Math.round((s?.volume ?? 1) * 100);
  $('vol').value = v;
  $('volLabel').textContent = `${v}%`;
  $('mute').textContent = s?.muted ? 'Unmute' : 'Mute';
  const z = Math.round((s?.zoom ?? 1) * 100);
  $('zoom').value = z;
  $('zoomReset').textContent = `${z}%`;
  $('zoom').disabled = !s?.fs;
  $('zoomReset').disabled = !s?.fs || z === 100;
  $('zoom').title = s?.fs ? 'Zoom' : 'Zoom: make a video in this frame fullscreen first';
}

$('bar').addEventListener('pointerdown', activity);
$('new').addEventListener('click', newFrame);
$('close').addEventListener('click', () => closeFrame());

$('url').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !selected) return;
  const ok = navigate(selected, $('url').value);
  $('url').setCustomValidity(ok ? '' : 'Not a valid address');
  if (ok) $('url').blur();
  else $('url').reportValidity();
});
$('url').addEventListener('input', () => $('url').setCustomValidity(''));
$('url').addEventListener('blur', () => setTimeout(() => {
  if (document.activeElement === document.body) syncBar();
}, 0));

for (const [id, action] of [['back', 'back'], ['fwd', 'forward'], ['reload', 'reload']]) {
  $(id).addEventListener('click', () => {
    const s = cells.get(selected);
    if (!s?.iframe) return;
    if (s.crashed) navigate(selected, s.url);
    else if (s.script) sendTo(s.frameId, { type: 'mv:nav', action });
    else if (action === 'reload') s.iframe.src = s.url;
  });
}

$('vol').addEventListener('input', () => {
  const s = cells.get(selected);
  if (!s) return;
  s.volume = $('vol').value / 100;
  $('volLabel').textContent = `${$('vol').value}%`;
  pushAudio(selected);
});

$('mute').addEventListener('click', () => {
  const s = cells.get(selected);
  if (!s) return;
  s.muted = !s.muted;
  syncBar();
  pushAudio(selected);
});

$('zoom').addEventListener('input', () => { if (selected) setZoom(selected, $('zoom').value / 100); });
$('zoomReset').addEventListener('click', () => { if (selected) setZoom(selected, 1); });

// Esc pressed while focus is in our own UI, e.g. right after using the zoom slider.
document.addEventListener('keydown', (e) => {
  const s = cells.get(selected);
  if (e.key === 'Escape' && s?.fs && !popupOpen() && !$('confirm').open) sendTo(s.frameId, { type: 'mv:exitfs' });
}, true);

// ---- layout picker ----

function buildPicker() {
  for (let r = 1; r <= 4; r++) {
    for (let c = 1; c <= 4; c++) {
      const b = document.createElement('button');
      b.dataset.r = r;
      b.dataset.c = c;
      b.setAttribute('aria-label', `${r} rows, ${c} columns`);
      const hint = () => {
        for (const x of $('pickerGrid').children) x.classList.toggle('on', x.dataset.r <= r && x.dataset.c <= c);
        $('pickerLabel').textContent = `${r} × ${c}`;
      };
      b.addEventListener('pointerenter', hint);
      b.addEventListener('focus', hint);
      b.addEventListener('click', () => { applyGrid(r, c); closePopups(); });
      $('pickerGrid').append(b);
    }
  }
}

addPopup($('layoutBtn'), $('picker'), () => {
  const loaded = loadedCount();
  for (const b of $('pickerGrid').children) {
    b.disabled = b.dataset.r * b.dataset.c < loaded; // would have to close a loaded frame
    b.classList.remove('on');
  }
  $('pickerLabel').textContent = 'Rows × columns';
});

init();
