// Auto-hide for the bar, and the popups that open from it.

const HIDE_MS = 600;
const INTRO_MS = 3000;

const $ = (id) => document.getElementById(id);
const bar = $('bar');
const TEXT_TYPES = new Set(['text', 'search', 'url']);
export const isTextInput = (el) => el?.tagName === 'INPUT' && TEXT_TYPES.has(el.type);

// ---- popups ----

const popups = []; // { button, panel, onOpen }

export function addPopup(button, panel, onOpen) {
  popups.push({ button, panel, onOpen });
  button.setAttribute('aria-haspopup', 'true');
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('click', () => setPopup(panel.hidden ? panel : null));
}

function setPopup(panel) {
  for (const p of popups) {
    const show = p.panel === panel;
    if (show && p.panel.hidden) p.onOpen();
    p.panel.hidden = !show;
    p.button.setAttribute('aria-expanded', String(show));
  }
}

export const closePopups = () => setPopup(null);
export const popupOpen = () => popups.some((p) => !p.panel.hidden);

document.addEventListener('pointerdown', (e) => {
  // composedPath: a click handler may already have replaced the clicked element.
  const path = e.composedPath();
  if (path.includes($('confirm'))) return;
  if (!popups.some((p) => path.includes(p.panel) || path.includes(p.button))) closePopups();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('confirm').open) closePopups();
});

// ---- auto-hide ----
// The reveal strip is a child of the bar, so it counts as "over the bar" too.

let over = false;
let timer = null;

function show() {
  clearTimeout(timer);
  bar.classList.add('open');
}

function hideSoon(ms = HIDE_MS) {
  clearTimeout(timer);
  timer = setTimeout(hide, ms);
}

function hide() {
  const a = document.activeElement;
  const inBar = bar.contains(a);
  if (over || popupOpen() || $('confirm').open || bar.matches(':active') || (inBar && isTextInput(a))) {
    hideSoon();
    return;
  }
  bar.classList.remove('open');
  // A focused button that is off screen would still react to the keyboard.
  if (inBar && document.body.dataset.autohide === 'true') a.blur();
}

// pointermove, not pointerenter: after the pointer has gone into a cross-site
// frame, the browser may not send "enter" when it comes back.
bar.addEventListener('pointermove', () => { over = true; show(); });
bar.addEventListener('pointerleave', () => { over = false; hideSoon(); });
bar.addEventListener('focusin', () => { show(); hideSoon(); });

/** The pointer was seen inside a frame, so it can't be over the bar. */
export function pointerInFrame() {
  if (!over) return;
  over = false;
  hideSoon();
}

/** Show the bar for a moment when the grid opens, so people know it's there. */
export function introduceBar() {
  show();
  hideSoon(INTRO_MS);
}
