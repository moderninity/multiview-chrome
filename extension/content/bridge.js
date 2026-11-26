// ISOLATED world. Runs in every frame but only
// acts when the top-level page is this extension's grid page.
(() => {
  const ao = location.ancestorOrigins;
  if (!ao || !ao.length || ao[ao.length - 1] !== `chrome-extension://${chrome.runtime.id}`) return;
  const isCellTop = ao.length === 1;
  const CORNER_W = 76;
  const CORNER_H = 40;

  addEventListener('mv-ask', () => dispatchEvent(new Event('mv-enable')));
  dispatchEvent(new Event('mv-enable'));

  const send = (m) => {
    try { chrome.runtime.sendMessage(m).catch(() => {}); } catch { /* extension reloaded */ }
  };

  send({ type: 'mv:hello', isCellTop, name: isCellTop ? window.name : null, url: location.href });

  // Pointer near the top-right corner: the grid shows the close button there
  let inCorner = false;
  const setCorner = (on) => {
    if (on === inCorner) return;
    inCorner = on;
    send({ type: 'mv:corner', on, top: isCellTop, at: Date.now() });
  };
  addEventListener('pointermove', (e) => {
    setCorner(e.clientX > innerWidth - CORNER_W && e.clientY < CORNER_H);
  }, { capture: true, passive: true });
  document.addEventListener('pointerleave', () => setCorner(false));

  // Selection + activity
  let lastInput = 0;
  let lastActivity = 0;
  addEventListener('pointerdown', (e) => {
    if (!e.isTrusted) return; // page-generated events aren't clicks
    lastInput = Date.now();
    send({ type: 'mv:interact' });
  }, true);
  const onActivity = (e) => {
    const now = Date.now();
    if (e.type !== 'pointermove') lastInput = now;
    if (now - lastActivity > 500) {
      lastActivity = now;
      send({ type: 'mv:activity', pointer: e.type === 'pointermove', corner: inCorner, top: isCellTop, at: now });
    }
  };
  for (const t of ['pointermove', 'keydown', 'wheel']) {
    addEventListener(t, onActivity, { capture: true, passive: true });
  }

  // Links aimed at the top window would replace the whole grid; keep them in the cell.
  const topTarget = (el) => {
    const t = (el.target || document.querySelector('base[target]')?.target || '').toLowerCase();
    return t === '_top' || (isCellTop && t === '_parent');
  };
  const linkIn = (e) => e.composedPath().find((n) => (n.tagName === 'A' || n.tagName === 'AREA') && n.href);
  if (isCellTop) {
    addEventListener('click', (e) => { const a = linkIn(e); if (a && topTarget(a)) a.target = '_self'; }, true);
    addEventListener('submit', (e) => { if (topTarget(e.target)) e.target.target = '_self'; }, true);
  } else {
    addEventListener('click', (e) => {
      const a = linkIn(e);
      if (!a || !topTarget(a) || e.defaultPrevented || e.ctrlKey || e.metaKey || e.shiftKey || !/^https?:/.test(a.href)) return;
      e.preventDefault();
      send({ type: 'mv:open', url: a.href });
    });
  }

  if (isCellTop) {
    // Closes when the page goes away for any reason, including a crash.
    try { chrome.runtime.connect({ name: 'mv' }); } catch { /* extension reloaded */ }

    // URL tracking (SPA navigations fire nothing we can see from here, so poll)
    let url = null;
    let title = null;
    const report = () => {
      if (location.href === url && document.title === title) return;
      url = location.href;
      title = document.title;
      send({ type: 'mv:url', url, title });
    };
    report();
    setInterval(report, 1000);

    // Fullscreen state from main.js (MAIN world) -> grid
    addEventListener('mv-fs', () => {
      send({ type: 'mv:fs', on: document.documentElement.hasAttribute('data-mv-fs-active') });
    });
  }

  // Shadow roots that hold media. Media events don't cross them, so each gets
  // its own listeners. Closed roots are reachable only through chrome.dom.
  const roots = new Set([document]);
  const shadowOf = (el) => (el instanceof HTMLElement ? chrome.dom.openOrClosedShadowRoot(el) : null);
  const addRoot = (root) => {
    if (!root) return;
    if (!roots.has(root)) {
      roots.add(root);
      listenForMedia(root);
    }
    for (const el of root.querySelectorAll('*')) addRoot(shadowOf(el));
  };
  const queryAll = (selector) => [...roots].flatMap((r) => [...r.querySelectorAll(selector)]);
  /** Parent as laid out: through slots, and from a shadow root to its host. */
  const flatParent = (n) => {
    const up = n.assignedSlot ?? n.parentNode;
    return up instanceof ShadowRoot ? up.host : up instanceof Element ? up : null;
  };

  // Audio
  let audio = null; // { volume, muted } set by the grid
  let reapplyCount = 0;
  setInterval(() => { reapplyCount = 0; }, 1000);
  const isMedia = (el) => el instanceof HTMLMediaElement;
  const apply = (el) => {
    if (!audio) return;
    if (el.volume !== audio.volume) el.volume = audio.volume;
    if (el.muted !== audio.muted) el.muted = audio.muted;
  };
  const applyAll = () => queryAll('video, audio').forEach(apply);

  const onMedia = (e) => { if (isMedia(e.target)) apply(e.target); };
  const onVolume = (e) => {
    const el = e.target;
    if (!isMedia(el) || !audio) return;
    if (el.volume === audio.volume && el.muted === audio.muted) return;
    if (Date.now() - lastInput < 1500) {
      // User just interacted with the page: treat as the site's own volume control.
      if (!el.paused) send({ type: 'mv:volume', volume: el.volume, muted: el.muted });
    } else if (reapplyCount++ < 5) {
      apply(el); // automatic change (e.g. player restoring its saved volume): keep ours
    }
  };
  function listenForMedia(root) {
    for (const t of ['play', 'loadedmetadata']) root.addEventListener(t, onMedia, true);
    root.addEventListener('volumechange', onVolume, true);
  }
  listenForMedia(document);
  const onShadowEvent = (e) => {
    for (const n of e.composedPath()) addRoot(shadowOf(n));
    applyAll();
  };
  addEventListener('mv-media', onShadowEvent, true); // from main.js
  // Shadow roots written in the page's HTML aren't announced by main.js.
  document.addEventListener('DOMContentLoaded', () => {
    for (const el of document.querySelectorAll('*')) addRoot(shadowOf(el));
  });

  // Zoom: enlarge the fullscreened video from its centre. The frame's own edges
  // cut off the rest; the player's controls aren't scaled.
  let zoom = 1;
  let zoomTimer = null;
  let zoomed = []; // [element, property, previous value, previous priority]

  const override = (el, prop, value) => {
    zoomed.push([el, prop, el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)]);
    el.style.setProperty(prop, value, 'important');
  };
  const undoZoom = () => {
    for (const [el, prop, value, priority] of zoomed.reverse()) {
      if (value) el.style.setProperty(prop, value, priority);
      else el.style.removeProperty(prop);
    }
    zoomed = [];
  };
  const area = (el) => el.offsetWidth * el.offsetHeight;
  const fsVideo = () => {
    const fs = queryAll('[data-mv-fs]')[0];
    if (!fs) return null;
    const inside = (el) => { while (el && el !== fs) el = flatParent(el); return !!el; };
    return queryAll('video').filter(inside).sort((a, b) => area(b) - area(a))[0] ?? null;
  };
  const applyZoom = () => {
    const v = zoom === 1 ? null : fsVideo();
    if (!v) { undoZoom(); return; }
    if (zoomed[0]?.[0] === v && v.style.getPropertyPriority('scale') === 'important') {
      v.style.setProperty('scale', zoom, 'important');
      return;
    }
    undoZoom();
    override(v, 'scale', zoom);
    override(v, 'transform-origin', 'center');
    // A wrapper that hugs the video would cut it off before the frame's edge.
    for (let a = flatParent(v); a && !v.hasAttribute('data-mv-fs') && !a.hasAttribute('data-mv-fs'); a = flatParent(a)) {
      if (a.clientWidth >= innerWidth - 1 && a.clientHeight >= innerHeight - 1) break;
      override(a, 'overflow', 'visible');
      override(a, 'contain', 'none');
    }
  };
  const setZoom = (value) => {
    zoom = value;
    clearInterval(zoomTimer);
    // Players swap their video element (ads, next video); keep up with that.
    zoomTimer = zoom === 1 ? null : setInterval(applyZoom, 500);
    applyZoom();
  };
  addEventListener('mv-fs', (e) => { onShadowEvent(e); applyZoom(); });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'mv:ping') {
      sendResponse('mv:pong');
    } else if (msg.type === 'mv:audio') {
      audio = { volume: msg.volume, muted: msg.muted };
      applyAll();
    } else if (msg.type === 'mv:zoom') {
      setZoom(msg.zoom);
    } else if (msg.type === 'mv:exitfs') {
      dispatchEvent(new Event('mv-exit'));
    } else if (msg.type === 'mv:nav' && isCellTop) {
      if (msg.action === 'back') history.back();
      else if (msg.action === 'forward') history.forward();
      else location.reload();
    }
  });
})();
