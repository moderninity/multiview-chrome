// Saved data. local = kept permanently, session = cleared when the browser closes.

export const DEFAULTS = {
  edge: 'top',          // top | bottom | left | right
  autoHide: true,
  confirmReplace: true,
  idleSeconds: 60,      // 0 = outline never fades
  accent: '#3b82f6',
};
const HISTORY_MAX = 50;

const read = async (area, key, fallback) => (await chrome.storage[area].get(key))[key] ?? fallback;

// The lock keeps two quick changes (or two grid tabs) from overwriting each other.
const update = (area, key, fallback, fn) => navigator.locks.request(`mv-${key}`, async () => {
  const before = await read(area, key, fallback);
  const after = fn(before);
  if (after && after !== before) await chrome.storage[area].set({ [key]: after });
});

export const getSettings = async () => ({ ...DEFAULTS, ...await read('local', 'settings', {}) });
export const setSetting = (key, value) => update('local', 'settings', {}, (s) => ({ ...s, [key]: value }));

// Presets: [{ id, name, layout }]
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();
export const getPresets = () => read('local', 'presets', []);
export const findPreset = async (name) => (await getPresets()).find((p) => sameName(p.name, name));

/** Saves under a name, replacing a preset already using that name. */
export const savePreset = (name, layout) => update('local', 'presets', [], (list) => {
  const old = list.find((p) => sameName(p.name, name));
  if (old) return list.map((p) => (p === old ? { ...p, name, layout } : p));
  return [...list, { id: crypto.randomUUID(), name, layout }];
});
export const renamePreset = (id, name) => update('local', 'presets', [], (list) => list.map((p) => (p.id === id ? { ...p, name } : p)));
export const deletePreset = (id) => update('local', 'presets', [], (list) => list.filter((p) => p.id !== id));

// History: [{ url, title }], newest first
export const getHistory = () => read('session', 'history', []);
export const addHistory = (url, title) => update('session', 'history', [], (list) =>
  [{ url, title }, ...list.filter((h) => h.url !== url)].slice(0, HISTORY_MAX));
export const retitleHistory = (url, title) => update('session', 'history', [], (list) =>
  (list.some((h) => h.url === url && h.title !== title)
    ? list.map((h) => (h.url === url ? { url, title } : h)) : list));
export const clearHistory = () => update('session', 'history', [], () => []);

/** Calls the handler for a key ('settings', 'presets', 'history') when it changes. */
export function onChange(handlers) {
  chrome.storage.onChanged.addListener((changes) => {
    for (const key of Object.keys(changes)) handlers[key]?.();
  });
}
