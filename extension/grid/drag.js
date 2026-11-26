// Shared pointer dragging. While a drag is active a transparent shield covers
// the frames, which would otherwise swallow the pointer.

const START_PX = 5;
const shield = document.getElementById('shield');

let cancelActive = null; // an actual drag
let releasePress = null; // any press

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !cancelActive) return;
  e.stopImmediatePropagation(); // only cancel the drag; leave popups open
  cancelActive();
}, true);

// The release can go missing (let go outside the window, element removed). The
// shield must never stay up, so moving over it with no button held ends the press.
shield.addEventListener('pointermove', (e) => {
  if (e.buttons) return;
  shield.hidden = true;
  releasePress?.();
});

/**
 * opts: cursor, threshold, accepts(e), press(e), release(), start(e), move(e), drop(e), cancel(), end()
 * press/release wrap every press; start/end wrap an actual drag. a drag
 * ends with either drop or cancel, then end.
 */
export function draggable(el, opts) {
  const { threshold = START_PX } = opts;
  let pressed = null;
  let dragging = false;
  let swallowClick = false;

  const finish = (e, dropped) => {
    if (!pressed) return;
    pressed = null;
    releasePress = null;
    shield.hidden = true;
    if (dragging) {
      dragging = false;
      cancelActive = null;
      document.body.classList.remove('dragging');
      if (dropped) opts.drop?.(e);
      else opts.cancel?.();
      opts.end?.();
    }
    opts.release?.();
  };

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || opts.accepts?.(e) === false) return;
    pressed = e;
    swallowClick = false;
    el.setPointerCapture(e.pointerId);
    // On press, not on the first move: capture alone doesn't stop a frame from
    // taking the pointer, and a divider is only a few pixels wide.
    shield.style.cursor = opts.cursor ?? 'grabbing';
    shield.hidden = false;
    releasePress = () => finish(null, false);
    opts.press?.(e);
  });
  el.addEventListener('pointermove', (e) => {
    if (!pressed) return;
    if (!e.buttons) { finish(e, false); return; }
    if (!dragging) {
      if (Math.hypot(e.clientX - pressed.clientX, e.clientY - pressed.clientY) < threshold) return;
      dragging = swallowClick = true;
      document.body.classList.add('dragging');
      cancelActive = () => finish(null, false);
      opts.start?.(pressed);
    }
    opts.move?.(e);
  });
  el.addEventListener('pointerup', (e) => finish(e, true));
  el.addEventListener('pointercancel', (e) => finish(e, false));
  el.addEventListener('lostpointercapture', (e) => finish(e, false));
  el.addEventListener('click', (e) => {
    if (!swallowClick) return;
    swallowClick = false;
    e.stopImmediatePropagation();
    e.preventDefault();
  }, true);
}
