// ISOLATED world, every page and frame. Ctrl+Shift+click on a link sends it
// to the MultiView grid as a new frame instead of opening a tab.
addEventListener('click', (e) => {
  if (!e.isTrusted || e.button !== 0 || !e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return;
  const a = e.composedPath().find((n) => (n.tagName === 'A' || n.tagName === 'AREA') && n.href);
  if (!a || !/^https?:/.test(a.href)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  try { chrome.runtime.sendMessage({ type: 'multiview:open', url: a.href }).catch(() => {}); } catch { /* extension reloaded */ }
}, true);
