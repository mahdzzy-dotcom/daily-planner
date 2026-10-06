'use strict';

// Tiny helpers for building the screens. Text is always added as text (never as HTML),
// so a task title can never break the page.

(function () {
  const DP = (window.DP = window.DP || {});

  // h('div', { class: 'x', onclick: fn, dataset: {a: 1} }, 'text', childNode, [more])
  DP.h = function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key === 'style') Object.assign(el.style, value);
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
      else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'selected') el[key] = value;
      else el.setAttribute(key, value === true ? '' : value);
    }
    const add = (child) => {
      if (Array.isArray(child)) child.forEach(add);
      else if (child === null || child === undefined || child === false) return;
      else el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
    };
    children.forEach(add);
    return el;
  };

  DP.clear = function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
  };

  // Calls the planner service in the main process. Error messages are cleaned up for people.
  DP.call = async function call(method, ...args) {
    try {
      return await window.api.call(method, ...args);
    } catch (error) {
      const raw = String((error && error.message) || error);
      throw new Error(raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '').replace(/^Error: /, ''));
    }
  };

  DP.debounce = function debounce(fn, ms) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  };

  DP.toast = function toast(message, kind) {
    const root = document.getElementById('toast-root');
    const el = DP.h('div', { class: `toast ${kind || ''}`, text: message });
    root.appendChild(el);
    setTimeout(() => el.remove(), 4500);
  };

  // ---- Modal dialogs ---------------------------------------------------------------------------------

  // Opens a dialog. Returns { close, body, footer }.
  DP.openDialog = function openDialog({ title, wide, onClose }) {
    const root = document.getElementById('dialog-root');
    const previousFocus = document.activeElement;
    const body = DP.h('div', { class: 'dialog-body' });
    const footer = DP.h('div', { class: 'dialog-footer' });
    const closeBtn = DP.h('button', { class: 'icon-btn', 'aria-label': 'Close', text: '✕' });
    const box = DP.h(
      'div',
      { class: `dialog ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      DP.h('div', { class: 'dialog-header' }, DP.h('h2', { text: title }), closeBtn),
      body,
      footer
    );
    const overlay = DP.h('div', { class: 'overlay' }, box);
    let closed = false;

    function close(result) {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (previousFocus && previousFocus.focus) previousFocus.focus();
      if (onClose) onClose(result);
    }
    function onKey(event) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    }
    closeBtn.addEventListener('click', () => close());
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) close();
    });
    document.addEventListener('keydown', onKey, true);
    root.appendChild(overlay);
    return { close, body, footer, box };
  };

  // A small question with buttons. choices: [{ label, value, kind }]. Resolves to the chosen value or null.
  DP.ask = function ask({ title, message, choices }) {
    return new Promise((resolve) => {
      let answered = false;
      const dlg = DP.openDialog({
        title,
        onClose: () => {
          if (!answered) resolve(null);
        },
      });
      dlg.body.appendChild(DP.h('p', { class: 'dialog-message', text: message }));
      for (const choice of choices) {
        dlg.footer.appendChild(
          DP.h('button', {
            class: `btn ${choice.kind || ''}`,
            text: choice.label,
            onclick: () => {
              answered = true;
              dlg.close();
              resolve(choice.value);
            },
          })
        );
      }
    });
  };

  // "This occurrence only / This and following / All occurrences" chooser.
  DP.askScope = function askScope({ title, verb, allowThis }) {
    return new Promise((resolve) => {
      let answered = false;
      const dlg = DP.openDialog({
        title,
        onClose: () => {
          if (!answered) resolve(null);
        },
      });
      const options = [
        { value: 'this', label: 'This occurrence only', disabled: allowThis === false },
        { value: 'following', label: 'This and following occurrences' },
        { value: 'all', label: 'All occurrences' },
      ];
      let chosen = options.find((o) => !o.disabled).value;
      dlg.body.appendChild(DP.h('p', { class: 'dialog-message', text: `${verb} which occurrences of this repeating task?` }));
      for (const option of options) {
        dlg.body.appendChild(
          DP.h(
            'label',
            { class: `choice ${option.disabled ? 'disabled' : ''}` },
            DP.h('input', {
              type: 'radio',
              name: 'scope',
              disabled: option.disabled,
              checked: option.value === chosen,
              onchange: () => (chosen = option.value),
            }),
            DP.h('span', { text: option.label })
          )
        );
      }
      if (allowThis === false) {
        dlg.body.appendChild(DP.h('p', { class: 'hint', text: 'The repeat pattern can only be changed for all or following occurrences.' }));
      }
      dlg.footer.appendChild(DP.h('button', { class: 'btn', text: 'Cancel', onclick: () => dlg.close() }));
      dlg.footer.appendChild(
        DP.h('button', {
          class: 'btn primary',
          text: verb === 'Delete' ? 'Delete' : 'Save',
          onclick: () => {
            answered = true;
            dlg.close();
            resolve(chosen);
          },
        })
      );
    });
  };
})();
