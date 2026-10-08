'use strict';

// The full-screen reminder page. The main process tells it what to show; it reports button presses.

(function () {
  const DP = window.DP;
  const root = document.getElementById('alert-root');

  let state = null; // { items, appearance, snoozeMinutes, guardMs }
  let guardUntil = 0;
  let lastItemId = null;
  let guardTimer = null;

  function current() {
    return state && state.items.length > 0 ? state.items[0] : null;
  }

  function draw() {
    const item = current();
    if (!item) return;
    const guardActive = performance.now() < guardUntil;
    DP.AlertView.render(root, {
      item,
      remaining: state.items.length - 1,
      appearance: state.appearance,
      snoozeMinutes: state.snoozeMinutes,
      guardActive,
    }, {
      dismiss: () => window.alertApi.action('dismiss', item.id),
      snooze: () => window.alertApi.action('snooze', item.id),
      done: () => window.alertApi.action('done', item.id),
      open: () => window.alertApi.action('open', item.id),
    });
    if (guardActive) {
      clearTimeout(guardTimer);
      guardTimer = setTimeout(draw, guardUntil - performance.now() + 20);
    } else {
      const primary = root.querySelector('button.primary');
      if (primary) primary.focus();
    }
  }

  window.alertApi.onRender((next) => {
    const first = !state;
    state = next;
    const item = current();
    // A new task on screen (or the first one): ignore presses for a moment so nothing is dismissed by accident.
    if (item && (first || item.id !== lastItemId)) {
      guardUntil = performance.now() + next.guardMs;
      lastItemId = item.id;
    }
    draw();
  });

  // Keyboard: Enter or Escape = "Got it", once the short pause is over.
  document.addEventListener('keydown', (event) => {
    const item = current();
    if (!item || performance.now() < guardUntil) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      window.alertApi.action('dismiss', item.id);
    }
  });

  window.alertApi.ready();
})();
