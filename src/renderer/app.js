'use strict';

// Daily Planner - main screen logic (Daily View, navigation, bell, menu).

(function () {
  const DP = (window.DP = window.DP || {});
  const { h, clear } = DP;

  DP.state = { settings: null, categories: [], cities: [], methods: [], dayKey: null, view: 'daily', day: null };

  const view = () => document.getElementById('view');
  const anyDialogOpen = () => document.querySelector('.overlay') !== null;

  DP.applyTheme = function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  };

  // ---- Daily View ---------------------------------------------------------------------------------------------

  function taskRow(t) {
    const tags = [];
    if (t.categoryName) {
      tags.push(h('span', { class: 'tag' }, h('span', { class: 'dot', style: { background: t.categoryColor } }), t.categoryName));
    }
    if (t.followsTitle) tags.push(h('span', { class: 'tag', title: 'Starts relative to another task', text: `↳ Follows “${t.followsTitle}”` }));
    if (t.startWarning) tags.push(h('span', { class: 'tag warn', title: t.startWarning, text: '⚠ Backup start time' }));
    if (t.isRecurring) tags.push(h('span', { class: 'tag', title: 'Repeats', text: '↻ Repeats' }));
    if (t.hasReminders) tags.push(h('span', { class: 'tag', title: 'Reminder on', text: '🔔 Reminder' }));
    if (t.overlaps) tags.push(h('span', { class: 'tag warn', title: 'Overlaps another task', text: '⚠ Overlaps' }));
    if (t.extendsPastZoneEnd) tags.push(h('span', { class: 'tag', title: 'Continues into the next zone', text: '→ Continues into next zone' }));
    if (t.overdue) tags.push(h('span', { class: 'tag late', text: 'Not done' }));

    const check = h('button', {
      class: `check ${t.done ? 'on' : ''}`, type: 'button', text: '✓',
      'aria-label': t.done ? `Mark "${t.title}" as not done` : `Mark "${t.title}" as done`, 'aria-pressed': String(t.done),
      onclick: async (event) => {
        event.stopPropagation();
        try {
          await DP.call('setDone', { taskId: t.taskId, dateKey: t.dateKey, done: !t.done });
          DP.afterChange();
        } catch (error) {
          DP.toast(error.message, 'error');
        }
      },
    });

    return h('div', {
      class: `task ${t.done ? 'done' : ''} ${t.overdue ? 'overdue' : ''}`, role: 'button', tabindex: '0',
      'aria-label': `${t.title}, ${t.startLabel}`,
      onclick: () => DP.openTaskForm({ mode: 'edit', taskId: t.taskId, dateKey: t.dateKey }),
      onkeydown: (e) => { if (e.key === 'Enter') DP.openTaskForm({ mode: 'edit', taskId: t.taskId, dateKey: t.dateKey }); },
    },
      h('div', { class: 'task-time' }, t.startLabel, t.afterMidnight ? h('small', { text: 'next day' }) : null),
      h('div', { class: 'task-main' },
        h('div', { class: 'task-title', text: t.title }),
        tags.length ? h('div', { class: 'task-meta' }, tags) : null),
      h('div', { class: 'task-duration', text: t.durationLabel }),
      h('span', { class: `prio ${t.priority}`, title: `${t.priority} priority` }),
      check);
  }

  function zoneSection(z) {
    const timeline = h('div', { class: 'timeline' });
    z.segments.forEach((s) =>
      timeline.appendChild(h('div', {
        class: `seg ${s.done ? 'done' : ''}`,
        style: Object.assign({ left: `${s.leftPct}%`, width: `${s.widthPct}%` }, s.color ? { background: s.color } : {}),
      })));
    if (z.nowPct !== null) timeline.appendChild(h('div', { class: 'now', style: { left: `calc(${z.nowPct}% - 1px)` }, title: 'Now' }));

    const body = h('div', { class: 'zone-body' });
    z.continued.forEach((c) =>
      body.appendChild(h('div', {
        class: 'continues', text: `↳ Continues from “${c.title}” (${c.minutesLabel} here, until ${c.endLabel})`,
        onclick: () => DP.openTaskForm({ mode: 'edit', taskId: c.taskId, dateKey: c.dateKey }),
      })));
    if (z.tasks.length === 0 && z.continued.length === 0) {
      body.appendChild(h('div', { class: 'empty-zone', text: 'No tasks in this zone yet.' }));
    }
    z.tasks.forEach((t) => body.appendChild(taskRow(t)));

    return h('section', { class: `zone z${z.index} ${z.isCurrent ? 'current' : ''}`, 'aria-label': z.name },
      h('div', { class: 'zone-head' },
        h('h2', { class: 'zone-name' }, z.name.toUpperCase(), z.isCurrent ? h('span', { class: 'now-chip', text: 'NOW' }) : null),
        h('div', { class: 'zone-times' }, h('span', { text: z.startLabel }), timeline, h('span', { text: z.endLabel })),
        h('div', { class: 'zone-figures' },
          h('span', {}, 'Total Duration:', h('b', { text: z.totalLabel })),
          h('span', {}, 'Scheduled Duration:', h('b', { text: z.scheduledLabel })),
          h('span', { class: 'free' }, 'Free Duration:', h('b', { text: z.freeLabel })))),
      body);
  }

  function renderDay() {
    const day = DP.state.day;
    const root = clear(view());

    const picker = h('input', {
      type: 'date', value: day.planningDayKey, 'aria-label': 'Jump to date',
      onchange: (e) => { if (e.target.value) DP.showDay(e.target.value); },
    });

    root.append(
      h('div', { class: 'day-head' },
        h('div', { class: 'day-nav' },
          h('button', { class: 'nav-btn', 'aria-label': 'Previous day', text: '◀', onclick: () => DP.showDay(day.prevKey) }),
          h('div', {},
            h('h1', { class: 'day-title' }, day.dateTitle, day.isCurrentDay ? h('span', { class: 'today-badge', text: 'TODAY' }) : null),
            h('div', { class: 'day-sub' },
              day.hijri ? h('span', { class: 'hijri', text: day.hijri }) : null,
              h('span', { text: day.planningLine }))),
          h('button', { class: 'nav-btn', 'aria-label': 'Next day', text: '▶', onclick: () => DP.showDay(day.nextKey) })),
        h('div', { class: 'day-actions' },
          h('button', { class: 'btn', text: 'Today', onclick: () => DP.showDay(DP.state.todayKey || day.currentPlanningDayKey) }),
          picker)),
      ...day.zones.map(zoneSection));
  }

  DP.showDay = async function showDay(key) {
    try {
      DP.state.view = 'daily';
      DP.state.dayKey = key;
      DP.state.day = await DP.call('getDay', key);
      DP.state.todayKey = DP.state.day.currentPlanningDayKey;
      renderDay();
    } catch (error) {
      DP.toast(error.message, 'error');
    }
  };

  DP.showDaily = function showDaily() {
    return DP.showDay(DP.state.dayKey || DP.state.todayKey);
  };

  DP.showSettings = function showSettings() {
    DP.state.view = 'settings';
    DP.renderSettings();
    window.scrollTo(0, 0);
  };

  // Called after anything changes the data.
  DP.afterChange = async function afterChange() {
    if (DP.state.view === 'daily') await DP.showDay(DP.state.dayKey);
  };

  // ---- Bell and menu ----------------------------------------------------------------------------------------------

  function closePopovers() {
    document.getElementById('bell-panel').hidden = true;
    document.getElementById('menu-panel').hidden = true;
  }

  async function toggleBell() {
    const panel = document.getElementById('bell-panel');
    const wasHidden = panel.hidden;
    closePopovers();
    if (!wasHidden) return;
    let list = [];
    try {
      list = await DP.call('getUpcoming');
    } catch (error) {
      DP.toast(error.message, 'error');
    }
    clear(panel).appendChild(h('h3', { text: 'Upcoming reminders' }));
    if (list.length === 0) panel.appendChild(h('div', { class: 'empty-zone', text: 'No reminders in the next 7 days.' }));
    list.forEach((r) =>
      panel.appendChild(h('div', {
        class: 'upcoming-item', role: 'button', tabindex: '0',
        onclick: () => { closePopovers(); DP.openTaskForm({ mode: 'edit', taskId: r.taskId, dateKey: r.dateKey }); },
      },
        h('div', { class: 'when', text: r.whenLabel }),
        h('div', { class: 'what', text: `${r.title} · starts ${r.startLabel} · ${r.zoneName}` }))));
    panel.hidden = false;
  }

  function toggleMenu() {
    const panel = document.getElementById('menu-panel');
    const wasHidden = panel.hidden;
    closePopovers();
    if (!wasHidden) return;
    const item = (label, fn) => h('button', { class: 'menu-item', text: label, onclick: () => { closePopovers(); fn(); } });
    clear(panel).append(
      item('Daily View', () => DP.showDaily()),
      item('Settings', () => DP.showSettings()),
      item('Export data…', () => DP.exportData()),
      item('Import data…', () => DP.importData()));
    panel.hidden = false;
  }

  // ---- Export / import --------------------------------------------------------------------------------------------------

  DP.exportData = async function exportData() {
    try {
      const result = await window.api.exportData();
      if (result && result.ok) DP.toast('Backup saved');
    } catch (error) {
      DP.toast(error.message, 'error');
    }
  };

  DP.importData = async function importData() {
    const go = await DP.ask({
      title: 'Import data',
      message: 'Importing a backup replaces ALL tasks, categories and settings on this computer with the contents of the file. Continue?',
      choices: [{ label: 'Cancel', value: false }, { label: 'Choose file…', value: true, kind: 'primary' }],
    });
    if (!go) return;
    try {
      const result = await window.api.importData();
      if (!result || result.canceled) return;
      await reloadEverything();
      const extra = result.warnings && result.warnings.length ? ` (${result.warnings.length} item(s) skipped)` : '';
      DP.toast(`Imported ${result.tasks} task(s)${extra}`);
      if (result.warnings && result.warnings.length) {
        const dlg = DP.openDialog({ title: 'Some items were skipped' });
        result.warnings.forEach((w) => dlg.body.appendChild(h('p', { text: w })));
        dlg.footer.appendChild(h('button', { class: 'btn primary', text: 'OK', onclick: () => dlg.close() }));
      }
    } catch (error) {
      DP.toast(error.message, 'error');
    }
  };

  async function reloadEverything() {
    const boot = await DP.call('bootstrap');
    Object.assign(DP.state, { settings: boot.settings, categories: boot.categories, cities: boot.cities, methods: boot.methods, todayKey: boot.currentPlanningDayKey });
    DP.applyTheme(boot.settings.theme);
    if (DP.state.view === 'settings') DP.renderSettings();
    else await DP.showDay(DP.state.todayKey);
  }

  // ---- Missed reminders --------------------------------------------------------------------------------------------------

  DP.showMissed = function showMissed(items) {
    if (!items || items.length === 0) return;
    const dlg = DP.openDialog({ title: items.length === 1 ? 'You missed 1 reminder' : `You missed ${items.length} reminders` });
    dlg.body.appendChild(h('p', { class: 'hint', text: 'These reminders came due while the computer was off or asleep:' }));
    items.forEach((i) =>
      dlg.body.appendChild(h('div', {
        class: 'upcoming-item', role: 'button', tabindex: '0',
        onclick: () => { dlg.close(); DP.openTaskForm({ mode: 'edit', taskId: i.taskId, dateKey: i.dateKey }); },
      },
        h('div', { class: 'when', text: i.title }),
        h('div', { class: 'what', text: `${i.alreadyStarted ? 'Started' : 'Starts'} at ${i.startLabel} · ${i.zoneName}` }))));
    dlg.footer.appendChild(h('button', { class: 'btn primary', text: 'OK', onclick: () => dlg.close() }));
  };

  // ---- Start-up -------------------------------------------------------------------------------------------------------------

  async function init() {
    document.getElementById('menu-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
    document.getElementById('bell-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleBell(); });
    document.getElementById('settings-btn').addEventListener('click', () => { closePopovers(); DP.showSettings(); });
    document.getElementById('add-btn').addEventListener('click', () => {
      closePopovers();
      DP.openTaskForm({ mode: 'create', defaultKey: DP.state.dayKey || DP.state.todayKey });
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.popover') && !e.target.closest('.icon-btn')) closePopovers();
    });

    try {
      await reloadEverything();
      const boot = await DP.call('bootstrap');
      if (boot.loadNotes && boot.loadNotes.length) DP.toast(boot.loadNotes[0], 'error');
    } catch (error) {
      clear(view()).appendChild(h('div', { class: 'errors', text: `Could not start: ${error.message}` }));
      return;
    }

    // The window keeps itself fresh: current zone, overdue marks, and changes made elsewhere.
    setInterval(() => { if (DP.state.view === 'daily' && !anyDialogOpen()) DP.afterChange(); }, 30000);
    window.addEventListener('focus', () => { if (!anyDialogOpen()) DP.afterChange(); });

    if (window.api && window.api.on) {
      window.api.on('data-changed', () => { if (!anyDialogOpen()) DP.afterChange(); });
      window.api.on('missed', (items) => DP.showMissed(items));
      window.api.on('open-task', ({ taskId, dateKey }) => {
        if (taskId && dateKey) DP.openTaskForm({ mode: 'edit', taskId, dateKey });
        else DP.showDay(DP.state.todayKey);
      });
    }
    // Tell the main process the window is ready to receive events (missed reminders, links from notifications).
    if (window.api && window.api.ready) window.api.ready();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
