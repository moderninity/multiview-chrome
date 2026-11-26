// The settings popup: Presets, History and Settings tabs.
import * as Store from './store.js';
import { addPopup, closePopups } from './bar.js';
import { draggable } from './drag.js';

const $ = (id) => document.getElementById(id);

function make(tag, props = {}, ...children) {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children);
  return el;
}

/**
 * grid: { captureLayout(), loadLayout(data), loadedCount(),
 *         loadIntoSelectedBlank(url), blankAt(x, y), loadIntoBlank(id, url), markDrop(id|null) }
 */
export function initMenu(grid) {
  addPopup($('menuBtn'), $('menu'), () => {
    message('presetMsg', '');
    message('historyMsg', '');
    renderPresets();
    renderHistory();
    renderSettings();
  });

  // ---- tabs ----

  const tabs = [...document.querySelectorAll('#tabs button')];
  const openTab = (tab) => {
    for (const t of tabs) {
      t.setAttribute('aria-selected', String(t === tab));
      $(t.dataset.pane).hidden = t !== tab;
    }
  };
  for (const t of tabs) t.addEventListener('click', () => openTab(t));
  openTab(tabs[0]);

  function message(id, text) { $(id).textContent = text; }

  // ---- presets ----

  let overwriteName = null; // name the user was just warned about

  $('presetName').addEventListener('input', () => { overwriteName = null; message('presetMsg', ''); });

  $('presetForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('presetName').value.trim();
    if (!name) { message('presetMsg', 'Enter a name first'); return; }
    if (overwriteName !== name && await Store.findPreset(name)) {
      overwriteName = name;
      message('presetMsg', `"${name}" already exists. Press Save again to overwrite it.`);
      return;
    }
    overwriteName = null;
    await Store.savePreset(name, grid.captureLayout());
    $('presetName').value = '';
    message('presetMsg', `Saved "${name}"`);
  });

  async function renderPresets() {
    const list = await Store.getPresets();
    $('presetList').replaceChildren(...list.map(presetRow));
    $('presetEmpty').hidden = list.length > 0;
  }

  function presetRow(preset) {
    const row = make('li');
    const load = make('button', { className: 'name', textContent: preset.name, title: `Load "${preset.name}"` });
    const rename = make('button', { textContent: 'Rename' });
    const del = make('button', { textContent: 'Delete' });
    load.addEventListener('click', () => loadPreset(preset));
    rename.addEventListener('click', () => startRename(row, preset));
    del.addEventListener('click', () => {
      if (del.dataset.sure) Store.deletePreset(preset.id);
      else { del.dataset.sure = '1'; del.textContent = 'Sure?'; }
    });
    const reset = () => { delete del.dataset.sure; del.textContent = 'Delete'; };
    del.addEventListener('pointerleave', reset);
    del.addEventListener('blur', reset);
    row.append(load, rename, del);
    return row;
  }

  function startRename(row, preset) {
    const input = make('input', { type: 'text', value: preset.name, maxLength: 60 });
    input.setAttribute('aria-label', 'Preset name');
    const form = make('form', {}, input, make('button', { textContent: 'OK' }));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) return;
      const other = await Store.findPreset(name);
      if (other && other.id !== preset.id) { message('presetMsg', `"${name}" is already used`); return; }
      message('presetMsg', '');
      await Store.renamePreset(preset.id, name);
      renderPresets(); // also when the name didn't change
    });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation(); // keep the popup open
      renderPresets();
    });
    row.replaceChildren(form);
    input.select();
  }

  async function loadPreset(preset) {
    if (grid.loadedCount() > 0 && (await Store.getSettings()).confirmReplace) {
      $('confirmText').textContent = `Replace all frames with preset "${preset.name}"?`;
      $('dontAsk').checked = false;
      const dialog = $('confirm');
      dialog.returnValue = '';
      dialog.showModal();
      await new Promise((done) => dialog.addEventListener('close', done, { once: true }));
      if (dialog.returnValue !== 'replace') return;
      if ($('dontAsk').checked) await Store.setSetting('confirmReplace', false);
    }
    if (grid.loadLayout(preset.layout)) closePopups();
    else message('presetMsg', `"${preset.name}" can't be read`);
  }

  // ---- history ----

  let pressing = false; // an entry is held; don't replace it under the pointer

  async function renderHistory() {
    if (pressing) return;
    const list = await Store.getHistory();
    if (pressing) return;
    $('historyList').replaceChildren(...list.map(historyRow));
    $('historyEmpty').hidden = list.length > 0;
    $('clearHistory').hidden = !list.length;
  }

  function historyRow({ url, title }) {
    const entry = make('button', { className: 'entry', title: url },
      make('span', { textContent: title || url }),
      make('small', { textContent: url.replace(/^https?:\/\/(www\.)?/, '') }));
    dragToBlank(entry, url, title || url);
    return make('li', {}, entry);
  }

  function dragToBlank(entry, url, label) {
    const ghost = make('div', { className: 'ghost', textContent: label });
    draggable(entry, {
      press: () => { pressing = true; },
      release: () => { pressing = false; renderHistory(); },
      start: () => document.body.append(ghost),
      move: (e) => {
        ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 12}px)`;
        grid.markDrop(grid.blankAt(e.clientX, e.clientY));
      },
      drop: (e) => {
        const target = grid.blankAt(e.clientX, e.clientY);
        if (target) grid.loadIntoBlank(target, url);
      },
      end: () => { ghost.remove(); grid.markDrop(null); },
    });
    entry.addEventListener('click', () => {
      message('historyMsg', grid.loadIntoSelectedBlank(url) ? '' : 'Select a blank frame first, or drag onto one');
    });
  }

  $('clearHistory').addEventListener('click', Store.clearHistory);

  // ---- settings ----

  const fields = {
    edge: $('setEdge'), autoHide: $('setAutoHide'), confirmReplace: $('setConfirm'),
    idleSeconds: $('setIdle'), accent: $('setAccent'),
  };
  for (const [key, el] of Object.entries(fields)) {
    el.addEventListener('change', () => {
      const value = el.type === 'checkbox' ? el.checked : key === 'idleSeconds' ? Number(el.value) : el.value;
      Store.setSetting(key, value);
    });
  }

  async function renderSettings() {
    const s = await Store.getSettings();
    for (const [key, el] of Object.entries(fields)) {
      if (el.type === 'checkbox') el.checked = s[key];
      else el.value = s[key];
    }
  }

  const ifOpen = (fn) => () => { if (!$('menu').hidden) fn(); };
  Store.onChange({
    presets: ifOpen(renderPresets), history: ifOpen(renderHistory), settings: ifOpen(renderSettings),
  });
}
