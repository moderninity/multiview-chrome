// Service worker: opens/focuses the grid tab and strips framing headers for
// sub-frames in that tab only. Holds no state (MV3 workers get shut down).

const GRID_URL = chrome.runtime.getURL('grid/grid.html');

const dropRule = (tabId) =>
  chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tabId] }).catch(() => {});

/** Focuses the most recent grid tab (or `preferId` if it's a grid), or opens one. Returns its id if it already existed. */
async function showGrid(preferId) {
  const grids = await chrome.tabs.query({ url: GRID_URL });
  grids.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  const grid = grids.find((t) => t.id === preferId) ?? grids[0];
  if (grid) {
    await chrome.tabs.update(grid.id, { active: true });
    await chrome.windows.update(grid.windowId, { focused: true });
    return grid.id;
  }
  await chrome.tabs.create({ url: GRID_URL });
  return null;
}

/** Sends a link to the grid as a frame. A new grid picks it up from session storage. */
async function openLink(url, fromTabId) {
  if (!/^https?:/.test(url ?? '')) return;
  const { pendingOpen = [] } = await chrome.storage.session.get('pendingOpen');
  const grids = await chrome.tabs.query({ url: GRID_URL });
  if (!grids.length) await chrome.storage.session.set({ pendingOpen: [...pendingOpen, url] });
  const gridId = await showGrid(fromTabId);
  if (gridId != null) chrome.runtime.sendMessage({ type: 'mv:openLink', tabId: gridId, url }).catch(() => {});
}

chrome.action.onClicked.addListener(() => showGrid());

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'mv-open-link', title: 'Open link in MultiView frame', contexts: ['link'] });
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'mv-open-link') openLink(info.linkUrl, tab?.id);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'multiview:open') { openLink(msg.url, sender.tab?.id); return; }
  if (msg?.type !== 'mv:register' || !sender.tab || sender.url?.split(/[?#]/)[0] !== GRID_URL) return;
  const tabId = sender.tab.id;
  chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [tabId],
    addRules: [{
      id: tabId,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          { header: 'x-frame-options', operation: 'remove' },
          { header: 'content-security-policy', operation: 'remove' },
        ],
      },
      condition: { tabIds: [tabId], resourceTypes: ['sub_frame'] },
    }],
  }).then(
    () => sendResponse({ ok: true }),
    (e) => sendResponse({ ok: false, error: String(e) }),
  );
  return true; // async response
});

// The rule must not outlive the grid: tab closed, or navigated somewhere else.
chrome.tabs.onRemoved.addListener(dropRule);
chrome.webNavigation.onCommitted.addListener(({ tabId, frameId, url }) => {
  if (frameId === 0 && !url.startsWith(GRID_URL)) dropRule(tabId);
});
