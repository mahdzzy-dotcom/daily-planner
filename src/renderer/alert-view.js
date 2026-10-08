'use strict';

// Draws the full-screen reminder. Used by the real alert page and by the preview in Settings.

(function () {
  const DP = (window.DP = window.DP || {});
  const { h, clear } = DP;

  function fontStack(name) {
    return `'${name}', 'Segoe UI', Tahoma, Arial, sans-serif`;
  }

  // Applies the user's choices to the stage element.
  function applyAppearance(stage, a) {
    const set = (name, value) => stage.style.setProperty(name, value);
    set('--a-bg', a.backgroundColor);
    set('--a-text', a.textColor);
    set('--a-accent', a.accentColor);
    set('--a-font', fontStack(a.fontFamily));
    set('--a-align', a.alignment);
    set('--a-items', a.alignment === 'left' ? 'flex-start' : 'center');
    set('--a-items-justify', a.alignment === 'left' ? 'flex-start' : 'center');
  }

  // state: { item, remaining, appearance, snoozeMinutes, guardActive }
  // handlers (optional): { dismiss, snooze, done, open } - called with no arguments
  function render(root, state, handlers) {
    const { item, appearance: a } = state;
    const frame = h('div', { class: 'alert-frame' });
    const stage = h('div', { class: 'alert-stage', role: 'alertdialog', 'aria-label': `Reminder: ${item.title}` });
    applyAppearance(stage, a);

    const name = h('h1', { class: 'alert-name', text: item.title });
    Object.assign(name.style, {
      fontSize: `${a.name.size}px`,
      color: a.name.color,
      fontWeight: a.name.bold ? '800' : '400',
      fontStyle: a.name.italic ? 'italic' : 'normal',
      textTransform: a.name.uppercase ? 'uppercase' : 'none',
    });

    const parts = [h('div', { class: 'alert-label', text: item.snoozed ? 'Snoozed reminder' : 'Starts now' }), name];

    if (a.notes.show && item.notes && item.notes.trim() !== '') {
      const notes = h('div', { class: 'alert-notes', text: item.notes });
      Object.assign(notes.style, {
        fontSize: `${a.notes.size}px`,
        color: a.notes.color,
        fontWeight: a.notes.bold ? '700' : '400',
        fontStyle: a.notes.italic ? 'italic' : 'normal',
      });
      parts.push(notes);
    }

    const chips = [];
    if (a.show.time) chips.push(h('span', { class: 'chip' }, h('b', { text: item.startLabel }), `– ${item.endLabel}`));
    if (a.show.duration) chips.push(h('span', { class: 'chip', text: item.durationLabel }));
    if (a.show.zone && item.zoneName) chips.push(h('span', { class: 'chip', text: `Zone: ${item.zoneName}` }));
    if (a.show.category && item.categoryName) {
      chips.push(h('span', { class: 'chip' }, h('span', { class: 'dot', style: { background: item.categoryColor || a.textColor } }), item.categoryName));
    }
    if (a.show.priority) chips.push(h('span', { class: 'chip', text: `${item.priority} priority` }));
    if (chips.length) parts.push(h('div', { class: 'alert-info' }, chips));

    const act = (key) => () => { if (handlers && handlers[key] && !state.guardActive) handlers[key](); };
    const button = (label, key, primary) =>
      h('button', { type: 'button', class: primary ? 'primary' : '', text: label, disabled: state.guardActive, onclick: act(key), dataset: { action: key } });
    parts.push(h('div', { class: 'alert-actions' },
      button('Got it', 'dismiss', true),
      button(`Snooze ${state.snoozeMinutes} min`, 'snooze', false),
      button('Open task', 'open', false),
      button('Mark as Done', 'done', false)));

    if (state.remaining > 0) {
      parts.push(h('div', { class: 'alert-more', text: state.remaining === 1 ? '1 more task starting now' : `${state.remaining} more tasks starting now` }));
    }

    stage.append(...parts);
    frame.appendChild(stage);
    clear(root).appendChild(frame);
    return { stage, frame };
  }

  DP.AlertView = { render, applyAppearance };
})();
