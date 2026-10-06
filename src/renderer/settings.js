'use strict';

// The Settings screen (spec 12.4). Every change is saved as soon as it is made.

(function () {
  const DP = (window.DP = window.DP || {});
  const { h, clear } = DP;

  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const PRAYERS = [['fajr', 'Fajr'], ['dhuhr', 'Dhuhr'], ['asr', 'Asr'], ['maghrib', 'Maghrib'], ['isha', 'Isha']];

  async function save(patch) {
    try {
      DP.state.settings = await DP.call('saveSettings', patch);
      DP.applyTheme(DP.state.settings.theme);
    } catch (error) {
      DP.toast(error.message, 'error');
      DP.state.settings = await DP.call('getSettings');
      DP.renderSettings();
    }
  }

  function toggle(label, checked, onChange, hint) {
    return h('div', {},
      h('label', { class: 'switch' },
        h('input', { type: 'checkbox', checked, onchange: (e) => onChange(e.target.checked) }),
        h('span', { text: label })),
      hint ? h('p', { class: 'hint', text: hint }) : null);
  }

  function numberField(value, min, max, suffix, onCommit, label) {
    return h('span', { class: 'row tight' },
      h('input', {
        type: 'number', class: 'num', min: String(min), max: String(max), value: String(value), 'aria-label': label,
        onchange: (e) => {
          const n = Number(e.target.value);
          onCommit(e.target.value === '' ? NaN : n);
        },
      }),
      suffix ? h('span', { text: suffix }) : null);
  }

  function section(title, ...children) {
    return h('section', { class: 'settings-section' }, h('h2', { text: title }), ...children);
  }

  function row(label, control) {
    return [h('label', { text: label }), control];
  }

  function categoriesSection() {
    const list = h('div');
    const draw = () => {
      clear(list);
      DP.state.categories.forEach((c) => {
        const name = h('input', { type: 'text', value: c.name, maxlength: '40', 'aria-label': `Name of ${c.name}` });
        const color = h('input', { type: 'color', value: c.color, 'aria-label': `Color of ${c.name}` });
        const commit = async () => {
          try {
            DP.state.categories = await DP.call('updateCategory', { id: c.id, name: name.value, color: color.value });
            DP.toast('Category saved');
          } catch (error) {
            DP.toast(error.message, 'error');
            name.value = c.name;
          }
          draw();
        };
        name.addEventListener('change', commit);
        color.addEventListener('change', commit);
        list.appendChild(h('div', { class: 'cat-row' }, color, name,
          h('button', {
            class: 'btn small danger', text: 'Delete',
            onclick: async () => {
              const ok = await DP.ask({
                title: 'Delete category', message: `Delete "${c.name}"? Tasks in this category are kept, but they become uncategorized.`,
                choices: [{ label: 'Cancel', value: false }, { label: 'Delete', value: true, kind: 'danger' }],
              });
              if (!ok) return;
              DP.state.categories = await DP.call('deleteCategory', { id: c.id });
              draw();
            },
          })));
      });
      const newName = h('input', { type: 'text', placeholder: 'New category name', maxlength: '40', 'aria-label': 'New category name' });
      const newColor = h('input', { type: 'color', value: '#3b82f6', 'aria-label': 'New category color' });
      list.appendChild(h('div', { class: 'cat-row' }, newColor, newName,
        h('button', {
          class: 'btn small primary', text: 'Add',
          onclick: async () => {
            try {
              DP.state.categories = await DP.call('addCategory', { name: newName.value, color: newColor.value });
              draw();
            } catch (error) {
              DP.toast(error.message, 'error');
            }
          },
        })));
    };
    draw();
    return section('Categories', list);
  }

  DP.renderSettings = function renderSettings() {
    const view = clear(document.getElementById('view'));
    const s = DP.state.settings;

    const city = h('select', { 'aria-label': 'City', onchange: (e) => save({ cityName: e.target.value }) },
      DP.state.cities.map((name) => h('option', { value: name, text: name, selected: s.cityName === name })));
    const method = h('select', { 'aria-label': 'Calculation method', onchange: (e) => save({ method: e.target.value }) },
      DP.state.methods.map((m) => h('option', { value: m.key, text: m.label, selected: s.method === m.key })));
    const adjustments = h('div', { class: 'row' },
      PRAYERS.map(([key, label]) => h('span', { class: 'row tight' },
        h('span', { text: label }),
        numberField(s.adjustments[key], -120, 120, 'min', (n) => save({ adjustments: { [key]: n } }), `${label} adjustment in minutes`))));
    const hijri = h('select', { 'aria-label': 'Hijri date adjustment', class: 'sel-auto', onchange: (e) => save({ hijriAdjustment: Number(e.target.value) }) },
      [[-1, '−1 day'], [0, 'No adjustment'], [1, '+1 day']].map(([v, l]) => h('option', { value: v, text: l, selected: s.hijriAdjustment === v })));

    const theme = h('select', { class: 'sel-auto', 'aria-label': 'Theme', onchange: (e) => save({ theme: e.target.value }) },
      [['system', 'System (follow Windows)'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => h('option', { value: v, text: l, selected: s.theme === v })));

    const workingDays = h('span', { class: 'daytoggle' },
      DAYS.map((label, i) => h('button', {
        type: 'button', class: s.workingDays.includes(i) ? 'on' : '', text: label, 'aria-pressed': String(s.workingDays.includes(i)),
        onclick: async () => {
          const next = s.workingDays.includes(i) ? s.workingDays.filter((d) => d !== i) : [...s.workingDays, i];
          await save({ workingDays: next });
          DP.renderSettings();
        },
      })));

    view.append(
      h('button', { class: 'back-link', text: '← Back to Daily View', onclick: () => DP.showDaily() }),
      h('h1', { text: 'Settings', style: { marginTop: '0' } }),

      section('Prayer Times',
        h('div', { class: 'settings-grid' },
          row('City', city),
          row('Calculation method', method),
          row('Manual adjustment', h('div', {}, adjustments, h('p', { class: 'hint', text: 'Minutes added to the calculated time (negative = earlier).' }))),
          row('Hijri date', hijri))),

      section('Reminders & Notifications',
        h('div', { class: 'settings-grid' },
          row('Notifications', toggle('Show notifications', s.notificationsEnabled, (v) => save({ notificationsEnabled: v }))),
          row('Sound', toggle('Play a sound', s.soundEnabled, (v) => save({ soundEnabled: v }))),
          row('Default reminder', h('div', {}, numberField(s.defaultReminderOffsetMinutes, 0, 10080, 'minutes before the start', (n) => save({ defaultReminderOffsetMinutes: n }), 'Default reminder minutes'),
            h('p', { class: 'hint', text: 'Used when a task has reminders turned on but no times added.' }))),
          row('Snooze', numberField(s.snoozeMinutes, 1, 1440, 'minutes', (n) => save({ snoozeMinutes: n }), 'Snooze minutes')),
          row('Zone start', toggle('Notify when each Zone begins', s.zoneStartNotifications, (v) => save({ zoneStartNotifications: v }), 'A notification at each prayer time.')))),

      section('Application',
        h('div', { class: 'settings-grid' },
          row('Start with Windows', toggle('Start Daily Planner when Windows starts (in the tray)', s.startWithWindows, (v) => save({ startWithWindows: v }))),
          row('Background message', toggle('Show the "still running in the background" message when closing', s.showBackgroundMessage, (v) => save({ showBackgroundMessage: v }))),
          row('Theme', theme),
          row('Working days', h('div', {}, workingDays, h('p', { class: 'hint', text: 'Used by "last working day" repeat rules.' }))))),

      categoriesSection(),

      section('Data',
        h('p', { class: 'dialog-message', text: 'Your data is stored only on this computer. Export a backup file to keep it safe or to move it to another computer.' }),
        h('div', { class: 'row' },
          h('button', { class: 'btn', text: 'Export data…', onclick: () => DP.exportData() }),
          h('button', { class: 'btn', text: 'Import data…', onclick: () => DP.importData() })))
    );
  };
})();
