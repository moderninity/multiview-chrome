// MAIN world, document_start. Replaces the Fullscreen API so "fullscreen" fills
// the frame's own viewport instead of the monitor. This world can't see our
// extension ID, so bridge.js decides whether to switch it on.
(() => {
  const ao = location.ancestorOrigins;
  if (!ao || !ao.length || !ao[ao.length - 1].startsWith('chrome-extension://')) return;

  // Either script may run first; both run before any page script.
  addEventListener('mv-enable', install, { once: true });
  dispatchEvent(new Event('mv-ask'));

  function install() {
    // YouTube's watch page crashes the frame (Chromium 158/159 CHECK failure) when
    // it starts a view transition inside an iframe. Without the function, sites
    // fall back to changing pages with no animation.
    delete Document.prototype.startViewTransition;

    const ATTR = 'data-mv-fs';
    const ANC = 'data-mv-fs-anc';
    const ROOT = 'data-mv-fs-active';
    const CSS = `
[${ATTR}] { position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important;
  max-width: none !important; max-height: none !important; min-width: 0 !important; min-height: 0 !important;
  margin: 0 !important; padding: 0 !important; border: 0 !important; box-sizing: border-box !important;
  transform: none !important; z-index: 2147483647 !important; background: #000 !important; }
[${ANC}] { transform: none !important; filter: none !important; backdrop-filter: none !important;
  perspective: none !important; contain: none !important; will-change: auto !important;
  container-type: normal !important; opacity: 1 !important; isolation: auto !important; z-index: 2147483647 !important; }
html[${ROOT}], html[${ROOT}] body { overflow: hidden !important; }`;
    // A constructed sheet, because a page's own CSP can block a <style> element.
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);

    let fsEl = null;
    let ancestors = [];
    let watch = null;

    /** Parent as laid out: through slots, and from a shadow root to its host. */
    const flatParent = (n) => {
      const p = n.assignedSlot ?? n.parentNode;
      return p instanceof ShadowRoot ? p.host : p instanceof Element ? p : null;
    };

    /** The element as seen from a document or shadow root (hosts stand in for their contents). */
    function seenFrom(el, scope) {
      while (el) {
        const root = el.getRootNode();
        if (root === scope) return el;
        el = root instanceof ShadowRoot ? root.host : null;
      }
      return null;
    }

    function ensureStyle(el) {
      const root = el.getRootNode();
      if ((root instanceof ShadowRoot || root === document) && !root.adoptedStyleSheets.includes(sheet)) {
        root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
      }
    }

    function fire(target, kind = 'change') {
      for (const t of [`fullscreen${kind}`, `webkitfullscreen${kind}`]) {
        target.dispatchEvent(new Event(t, { bubbles: true, composed: true }));
      }
    }

    function notify(on) {
      // bridge.js reads the attributes; the path tells it which shadow roots matter.
      (on ? fsEl : window).dispatchEvent(new Event('mv-fs', { bubbles: true, composed: true }));
      if (window.parent !== window) window.parent.postMessage({ __mv_fs: on }, '*');
    }

    // Same rule as the real API: only shortly after the user clicked or pressed a key.
    const userActed = () => navigator.userActivation?.isActive !== false;

    function enter(el) {
      if (fsEl === el) return;
      if (fsEl) leave(false);
      fsEl = el;
      el.setAttribute(ATTR, '');
      for (let a = flatParent(el); a; a = flatParent(a)) {
        a.setAttribute(ANC, '');
        ancestors.push(a);
      }
      document.documentElement.setAttribute(ROOT, '');
      const styleAll = () => [document.documentElement, el, ...ancestors].forEach(ensureStyle);
      styleAll();
      watch = setInterval(() => {
        if (!el.isConnected) leave(); // the page removed it
        else styleAll(); // the page may have replaced its style sheets
      }, 500);
      fire(el);
      notify(true);
    }

    function leave(announce = true) {
      if (!fsEl) return;
      const el = fsEl;
      fsEl = null;
      clearInterval(watch);
      el.removeAttribute(ATTR);
      for (const a of ancestors) a.removeAttribute(ANC);
      ancestors = [];
      document.documentElement.removeAttribute(ROOT);
      if (el.tagName === 'IFRAME') el.contentWindow?.postMessage({ __mv_fs_exit: true }, '*');
      fire(el.isConnected ? el : document);
      if (announce) notify(false);
      else dispatchEvent(new Event('mv-fs'));
    }

    function request(el) {
      if (!el.isConnected || !userActed()) {
        fire(el.isConnected ? el : document, 'error');
        return Promise.reject(new TypeError('Permissions check failed'));
      }
      enter(el);
      return Promise.resolve();
    }

    const E = Element.prototype;
    const D = Document.prototype;
    const S = ShadowRoot.prototype;
    const getter = (obj, key, get) => Object.defineProperty(obj, key, { get, configurable: true });

    E.requestFullscreen = function () { return request(this); };
    E.webkitRequestFullscreen = function () { request(this).catch(() => {}); };
    E.webkitRequestFullScreen = E.webkitRequestFullscreen;
    D.exitFullscreen = function () { leave(); return Promise.resolve(); };
    D.webkitExitFullscreen = function () { leave(); };
    D.webkitCancelFullScreen = D.webkitExitFullscreen;
    for (const P of [D, S]) getter(P, 'fullscreenElement', function () { return seenFrom(fsEl, this); });
    for (const key of ['webkitFullscreenElement', 'webkitCurrentFullScreenElement']) {
      getter(D, key, function () { return seenFrom(fsEl, this); });
    }
    for (const key of ['fullscreenEnabled', 'webkitFullscreenEnabled']) getter(D, key, () => true);
    for (const key of ['fullscreen', 'webkitIsFullScreen']) getter(D, key, () => !!fsEl);
    // Video elements have their own older names for the same thing.
    const V = HTMLVideoElement.prototype;
    if ('webkitEnterFullscreen' in V) {
      V.webkitEnterFullscreen = V.webkitEnterFullScreen = function () { request(this).catch(() => {}); };
      V.webkitExitFullscreen = V.webkitExitFullScreen = function () { leave(); };
      getter(V, 'webkitSupportsFullscreen', () => true);
      getter(V, 'webkitDisplayingFullscreen', function () { return fsEl === this; });
    }

    addEventListener('keydown', (e) => { if (e.key === 'Escape' && fsEl) leave(); }, true);
    addEventListener('mv-exit', () => leave()); // from bridge.js

    // Media events inside a shadow root never reach the document. Announce the
    // element with an event that does, so bridge.js can find that root.
    const announce = (e) => {
      if (e.target instanceof HTMLMediaElement) e.target.dispatchEvent(new Event('mv-media', { bubbles: true, composed: true }));
    };
    const attachShadow = E.attachShadow;
    E.attachShadow = function (init) {
      const root = attachShadow.call(this, init);
      for (const t of ['loadstart', 'loadedmetadata', 'play']) root.addEventListener(t, announce, true);
      return root;
    };

    function findFrame(win, root = document) {
      for (const el of root.querySelectorAll('*')) {
        if (el.tagName === 'IFRAME' && el.contentWindow === win) return el;
        const inside = el.shadowRoot && findFrame(win, el.shadowRoot);
        if (inside) return inside;
      }
      return null;
    }

    // Nested frames: a child that went fullscreen asks us to fill our viewport
    // with its <iframe>; the parent exiting tells the child to exit too.
    addEventListener('message', (e) => {
      const d = e.data;
      if (!d || typeof d !== 'object') return;
      if (d.__mv_fs_exit === true && e.source === window.parent) { leave(false); return; }
      if (typeof d.__mv_fs !== 'boolean' || (d.__mv_fs && !userActed())) return;
      const frame = findFrame(e.source);
      if (!frame) return;
      if (d.__mv_fs) enter(frame);
      else if (fsEl === frame) leave();
    });
  }
})();
