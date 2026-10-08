'use strict';

// The Add / Edit task form (spec 12.3).

(function () {
  const DP = (window.DP = window.DP || {});
  const { h, clear } = DP;

  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const PRAYERS = [
    ['fajr', 'Fajr'], ['dhuhr', 'Dhuhr'], ['asr', 'Asr'], ['maghrib', 'Maghrib'], ['isha', 'Isha'],
  ];
  const POSITIONS = [[1, '1st'], [2, '2nd'], [3, '3rd'], [4, '4th'], [-1, 'Last']];

  function weekdayOf(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  }

  function toggleInList(list, value) {
    return list.includes(value) ? list.filter((v) => v !== value) : [...list, value].sort((a, b) => a - b);
  }

  // ---- 12-hour time picker: hour, minute, AM/PM ----------------------------------------------------------

  DP.timePicker = function timePicker(value24, onChange) {
    let [hh, mm] = value24.split(':').map(Number);
    const hourSel = h('select', { class: 'sel-auto', 'aria-label': 'Hour' });
    for (let i = 1; i <= 12; i++) hourSel.appendChild(h('option', { value: i, text: String(i) }));
    const minSel = h('select', { class: 'sel-auto', 'aria-label': 'Minute' });
    for (let i = 0; i < 60; i++) minSel.appendChild(h('option', { value: i, text: String(i).padStart(2, '0') }));
    const ampmSel = h('select', { class: 'sel-auto', 'aria-label': 'AM or PM' }, h('option', { value: 'AM', text: 'AM' }), h('option', { value: 'PM', text: 'PM' }));

    hourSel.value = String(hh % 12 === 0 ? 12 : hh % 12);
    minSel.value = String(mm);
    ampmSel.value = hh >= 12 ? 'PM' : 'AM';

    function emit() {
      let hour = Number(hourSel.value) % 12;
      if (ampmSel.value === 'PM') hour += 12;
      const text = `${String(hour).padStart(2, '0')}:${String(Number(minSel.value)).padStart(2, '0')}`;
      onChange(text);
    }
    [hourSel, minSel, ampmSel].forEach((s) => s.addEventListener('change', emit));
    return h('span', { class: 'row tight' }, hourSel, h('span', { text: ':' }), minSel, ampmSel);
  };

  function offsetLabel(n) {
    if (n === 0) return 'At start time';
    if (n % 1440 === 0) return `${n / 1440} day${n === 1440 ? '' : 's'} before`;
    if (n < 60) return `${n} min before`;
    if (n % 60 === 0) return `${n / 60} hour${n === 60 ? '' : 's'} before`;
    return `${Math.floor(n / 60)}h ${n % 60}m before`;
  }

  function newRule(startDate) {
    return {
      startDate,
      frequency: 'weekly',
      interval: 1,
      weekdays: [weekdayOf(startDate)],
      end: { type: 'never' },
    };
  }

  // ---- The form ---------------------------------------------------------------------------------------------

  // options: { mode: 'create' | 'edit', taskId, dateKey, defaultKey }
  DP.openTaskForm = async function openTaskForm(options) {
    const isEdit = options.mode === 'edit';
    let info = null;
    let f;
    if (isEdit) {
      info = await DP.call('getTaskForEdit', { taskId: options.taskId, dateKey: options.dateKey });
      f = info.form;
    } else {
      f = await DP.call('newTaskDefaults', options.defaultKey);
    }
    const originalRule = f.recurrence ? JSON.stringify(f.recurrence) : null;
    const settings = DP.state.settings;
    // The other tasks this one could follow (for "Relative to Task").
    const choices = await DP.call('getReferenceChoices', { taskId: options.taskId || null });

    const dlg = DP.openDialog({ title: isEdit ? 'Edit task' : 'New task', wide: true });
    const errorsBox = h('div', { class: 'errors', hidden: true });
    const startBox = h('div');
    const startReadout = h('div', { class: 'readout' });
    const startWarning = h('div', { class: 'note start-warning', hidden: true });
    const endReadout = h('div', { class: 'readout', 'aria-label': 'End time' });
    const zoneReadout = h('div', { class: 'readout zone-readout', 'aria-label': 'Zone' });
    const placementNote = h('div', { class: 'note placement', hidden: true });
    const dateBox = h('div');
    const recurrenceBox = h('div');
    const remindersBox = h('div');
    let previewSeq = 0;

    // ---- preview ----
    const refreshPreview = DP.debounce(async () => {
      const seq = ++previewSeq;
      let p;
      try {
        p = await DP.call('previewForm', f, { taskId: options.taskId || null });
      } catch (error) {
        return;
      }
      if (seq !== previewSeq) return;

      if (p.resolved && p.resolved.warning) {
        startWarning.hidden = false;
        startWarning.textContent = p.resolved.warning;
      } else {
        startWarning.hidden = true;
      }

      startReadout.textContent = p.resolved ? p.resolved.startLabel : '—';
      endReadout.textContent = p.resolved && p.resolved.endLabel ? p.resolved.endLabel + (p.resolved.endsNextDay ? ' (next day)' : '') : '—';
      zoneReadout.className = `readout zone-readout ${p.placement ? `z${p.placement.zoneIndex}` : ''}`;
      zoneReadout.textContent = p.placement ? p.placement.zoneName : '—';
      if (p.placement && p.placement.differsFromDate) {
        placementNote.hidden = false;
        placementNote.textContent = p.placement.text;
      } else {
        placementNote.hidden = true;
      }

      const messages = p.errors.slice();
      showErrors(messages);
      renderRuleSummary(p.rule);
    }, 120);

    function showErrors(messages) {
      clear(errorsBox);
      errorsBox.hidden = messages.length === 0;
      messages.forEach((m) => errorsBox.appendChild(h('div', { text: m })));
    }

    function changed() {
      refreshPreview();
    }

    // ---- title ----
    const titleInput = h('input', {
      type: 'text', id: 'f-title', value: f.title, maxlength: '200', placeholder: 'What do you want to do?', autocomplete: 'off',
      oninput: (e) => { f.title = e.target.value; },
    });

    // ---- start time ----
    function renderStart() {
      clear(startBox);
      const mode = f.start.mode;
      const toggle = h(
        'div', { class: 'segmented', role: 'group', 'aria-label': 'Start time type' },
        h('button', {
          type: 'button', class: mode === 'fixed' ? 'on' : '', text: 'Fixed Time',
          onclick: () => { f.start = { mode: 'fixed', time: '09:00' }; renderStart(); changed(); },
        }),
        h('button', {
          type: 'button', class: mode === 'prayer' ? 'on' : '', text: 'Relative to Prayer',
          onclick: () => { f.start = { mode: 'prayer', prayer: 'asr', direction: 'after', minutes: 10 }; renderStart(); changed(); },
        }),
        h('button', {
          type: 'button', class: mode === 'task' ? 'on' : '', text: 'Relative to Task',
          onclick: () => {
            f.start = { mode: 'task', taskId: choices.length ? choices[0].taskId : '', point: 'end', direction: 'after', minutes: 0, fallbackTime: '09:00' };
            renderStart(); changed();
          },
        })
      );
      startBox.appendChild(toggle);

      if (mode === 'fixed') {
        startBox.appendChild(h('div', { class: 'row', style: { marginTop: '10px' } }, DP.timePicker(f.start.time, (t) => { f.start.time = t; changed(); })));
      } else if (mode === 'prayer') {
        const prayerSel = h('select', { class: 'sel-auto', 'aria-label': 'Prayer', onchange: (e) => { f.start.prayer = e.target.value; changed(); } },
          PRAYERS.map(([key, label]) => h('option', { value: key, text: label, selected: f.start.prayer === key })));
        const dirSel = h('select', { class: 'sel-auto', 'aria-label': 'Before or after', onchange: (e) => { f.start.direction = e.target.value; changed(); } },
          h('option', { value: 'before', text: 'before', selected: f.start.direction === 'before' }),
          h('option', { value: 'after', text: 'after', selected: f.start.direction === 'after' }));
        const mins = h('input', {
          type: 'number', class: 'num', min: '0', value: String(f.start.minutes), 'aria-label': 'Minutes',
          oninput: (e) => { f.start.minutes = e.target.value === '' ? NaN : Number(e.target.value); changed(); },
        });
        startBox.appendChild(h('div', { class: 'row', style: { marginTop: '10px' } }, mins, h('span', { text: 'minutes' }), dirSel, prayerSel));
      } else {
        // Relative to another task: "15 minutes after the end of <task>"
        const mins = h('input', {
          type: 'number', class: 'num', min: '0', value: String(f.start.minutes), 'aria-label': 'Minutes',
          oninput: (e) => { f.start.minutes = e.target.value === '' ? NaN : Number(e.target.value); changed(); },
        });
        const dirSel = h('select', { class: 'sel-auto', 'aria-label': 'Before or after', onchange: (e) => { f.start.direction = e.target.value; changed(); } },
          h('option', { value: 'before', text: 'before', selected: f.start.direction === 'before' }),
          h('option', { value: 'after', text: 'after', selected: f.start.direction === 'after' }));
        const pointSel = h('select', { class: 'sel-auto', 'aria-label': 'Start or end of that task', onchange: (e) => { f.start.point = e.target.value; changed(); } },
          h('option', { value: 'start', text: 'start', selected: f.start.point === 'start' }),
          h('option', { value: 'end', text: 'end', selected: f.start.point === 'end' }));
        const taskSel = h('select', { 'aria-label': 'Task to follow', onchange: (e) => { f.start.taskId = e.target.value; changed(); } },
          h('option', { value: '', text: choices.length ? 'Choose a task…' : 'There are no other tasks yet' }),
          choices.map((c) => h('option', { value: c.taskId, text: c.label, selected: f.start.taskId === c.taskId })));
        startBox.appendChild(h('div', { class: 'row', style: { marginTop: '10px' } },
          mins, h('span', { text: 'minutes' }), dirSel, h('span', { text: 'the' }), pointSel, h('span', { text: 'of' })));
        startBox.appendChild(h('div', { style: { marginTop: '8px' } }, taskSel));
        startBox.appendChild(h('div', { class: 'row', style: { marginTop: '10px' } },
          h('span', { class: 'hint', text: 'Backup start time, used on days when that task is not there:' }),
          DP.timePicker(f.start.fallbackTime, (t) => { f.start.fallbackTime = t; changed(); })));
      }
      renderDate();
    }

    // ---- duration ----
    const hoursInput = h('input', {
      type: 'number', class: 'num', min: '0', value: String(Math.floor(f.durationMinutes / 60)), 'aria-label': 'Duration hours',
      oninput: updateDuration,
    });
    const minutesInput = h('input', {
      type: 'number', class: 'num', min: '0', value: String(f.durationMinutes % 60), 'aria-label': 'Duration minutes',
      oninput: updateDuration,
    });
    function updateDuration() {
      const hrs = hoursInput.value === '' ? 0 : Number(hoursInput.value);
      const mns = minutesInput.value === '' ? 0 : Number(minutesInput.value);
      f.durationMinutes = hrs * 60 + mns;
      changed();
    }

    // ---- date ----
    function renderDate() {
      clear(dateBox);
      if (f.recurrence) return; // repeating tasks use the rule's start date
      dateBox.appendChild(
        h('div', { class: 'field' },
          h('label', { for: 'f-date', text: 'Date' }),
          h('input', { type: 'date', id: 'f-date', value: f.date || '', oninput: (e) => { f.date = e.target.value; changed(); } }),
          h('p', {
            class: 'hint',
            text: f.start.mode === 'task'
              ? 'The date of the task it follows: that day\'s occurrence of the other task is used.'
              : 'The calendar date of the start time. A task after midnight but before Fajr still appears under the previous Planning Day.',
          }))
      );
    }

    // ---- recurrence ----
    const ruleSummary = h('div', { class: 'summary' });
    const rulePreview = h('ul', { class: 'preview-list' });

    function renderRuleSummary(rule) {
      ruleSummary.textContent = rule ? rule.summary : '';
      clear(rulePreview);
      if (rule) {
        rulePreview.appendChild(h('li', { class: 'hint', text: 'Next occurrences:', style: { listStyle: 'none', marginInlineStart: '-18px' } }));
        rule.preview.forEach((d) => rulePreview.appendChild(h('li', { text: d.label })));
      }
    }

    function positionBoxes(spec) {
      return h('span', { class: 'daytoggle' },
        POSITIONS.map(([value, label]) =>
          h('button', {
            type: 'button', class: spec.positions.includes(value) ? 'on' : '', text: label,
            onclick: () => { spec.positions = toggleInList(spec.positions, value); renderRecurrence(); changed(); },
          })));
    }

    function weekdayToggles(getList, setList) {
      return h('span', { class: 'daytoggle' },
        DAYS.map((label, i) =>
          h('button', {
            type: 'button', class: getList().includes(i) ? 'on' : '', text: label, 'aria-pressed': String(getList().includes(i)),
            onclick: () => { setList(toggleInList(getList(), i)); renderRecurrence(); changed(); },
          })));
    }

    function weekdaySelect(spec) {
      return h('select', { class: 'sel-auto', 'aria-label': 'Weekday', onchange: (e) => { spec.weekday = Number(e.target.value); changed(); } },
        DAYS_LONG.map((label, i) => h('option', { value: i, text: label, selected: spec.weekday === i })));
    }

    function monthlyControls(r) {
      const m = r.monthly;
      const modes = [
        ['dayOfMonth', 'On day number(s)'],
        ['lastDay', 'On the last day of the month'],
        ['nthWeekday', 'On the …th weekday'],
        ['lastWorkingDay', 'On the last working day'],
        ['weekdaysInMonth', 'On every chosen weekday'],
      ];
      const defaults = {
        dayOfMonth: () => ({ type: 'dayOfMonth', days: [Number(r.startDate.slice(8, 10))] }),
        lastDay: () => ({ type: 'lastDay' }),
        nthWeekday: () => ({ type: 'nthWeekday', weekday: weekdayOf(r.startDate), positions: [1] }),
        lastWorkingDay: () => ({ type: 'lastWorkingDay' }),
        weekdaysInMonth: () => ({ type: 'weekdaysInMonth', weekdays: [weekdayOf(r.startDate)] }),
      };
      const wrap = h('div');
      for (const [type, label] of modes) {
        const active = m.type === type;
        let detail = null;
        if (active && type === 'dayOfMonth') {
          detail = h('input', {
            type: 'text', class: 'sel-auto', value: m.days.join(', '), placeholder: '1, 15', 'aria-label': 'Day numbers', style: { width: '140px' },
            oninput: (e) => {
              m.days = e.target.value.split(/[ ,]+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n));
              changed();
            },
          });
        } else if (active && type === 'nthWeekday') {
          detail = h('span', { class: 'row tight' }, positionBoxes(m), weekdaySelect(m));
        } else if (active && type === 'weekdaysInMonth') {
          detail = weekdayToggles(() => m.weekdays, (list) => { m.weekdays = list; });
        }
        wrap.appendChild(
          h('div', { class: 'row', style: { marginBottom: '6px' } },
            h('label', { class: 'switch' },
              h('input', { type: 'radio', name: 'monthly-mode', checked: active, onchange: () => { r.monthly = defaults[type](); renderRecurrence(); changed(); } }),
              h('span', { text: label })),
            detail)
        );
      }
      return wrap;
    }

    function yearlyControls(r) {
      const y = r.yearly;
      const monthSel = h('select', { class: 'sel-auto', 'aria-label': 'Month', onchange: (e) => { y.month = Number(e.target.value); changed(); } },
        MONTHS.map((label, i) => h('option', { value: i + 1, text: label, selected: y.month === i + 1 })));
      const isDay = y.type === 'dayOfMonth';
      return h('div', {},
        h('div', { class: 'row', style: { marginBottom: '6px' } },
          h('label', { class: 'switch' },
            h('input', { type: 'radio', name: 'yearly-mode', checked: isDay, onchange: () => { r.yearly = { month: y.month, type: 'dayOfMonth', day: Number(r.startDate.slice(8, 10)) }; renderRecurrence(); changed(); } }),
            h('span', { text: 'On day' })),
          isDay ? h('input', { type: 'number', class: 'num', min: '1', max: '31', value: String(y.day), 'aria-label': 'Day', oninput: (e) => { y.day = Number(e.target.value); changed(); } }) : null,
          h('span', { text: 'of' }), monthSel),
        h('div', { class: 'row' },
          h('label', { class: 'switch' },
            h('input', { type: 'radio', name: 'yearly-mode', checked: !isDay, onchange: () => { r.yearly = { month: y.month, type: 'nthWeekday', weekday: weekdayOf(r.startDate), positions: [1] }; renderRecurrence(); changed(); } }),
            h('span', { text: 'On the …th weekday' })),
          !isDay ? h('span', { class: 'row tight' }, positionBoxes(y), weekdaySelect(y)) : null));
    }

    function endControls(r) {
      const type = r.end.type;
      const radio = (value, label, extra) =>
        h('div', { class: 'row', style: { marginBottom: '6px' } },
          h('label', { class: 'switch' },
            h('input', {
              type: 'radio', name: 'end-mode', checked: type === value,
              onchange: () => {
                r.end = value === 'never' ? { type: 'never' } : value === 'date' ? { type: 'date', date: r.startDate } : { type: 'count', count: 10 };
                renderRecurrence(); changed();
              },
            }),
            h('span', { text: label })),
          type === value ? extra : null);
      return h('div', {},
        radio('never', 'Never ends'),
        radio('date', 'Ends on', h('input', { type: 'date', class: 'sel-auto', value: r.end.date || '', 'aria-label': 'End date', oninput: (e) => { r.end.date = e.target.value; changed(); } })),
        radio('count', 'Ends after', h('span', { class: 'row tight' },
          h('input', { type: 'number', class: 'num', min: '1', value: String(r.end.count), 'aria-label': 'Number of occurrences', oninput: (e) => { r.end.count = Number(e.target.value); changed(); } }),
          h('span', { text: 'occurrences' }))));
    }

    function renderRecurrence() {
      clear(recurrenceBox);
      const repeats = Boolean(f.recurrence);
      recurrenceBox.appendChild(
        h('div', { class: 'field' },
          h('div', { class: 'label', text: 'Repeat' }),
          h('div', { class: 'segmented', role: 'group', 'aria-label': 'Repeat' },
            h('button', { type: 'button', class: repeats ? '' : 'on', text: 'Does not repeat', onclick: () => { f.recurrence = null; renderDate(); renderRecurrence(); changed(); } }),
            h('button', { type: 'button', class: repeats ? 'on' : '', text: 'Repeats', onclick: () => { if (!f.recurrence) f.recurrence = newRule(f.date); renderDate(); renderRecurrence(); changed(); } })))
      );
      if (!repeats) return;
      const r = f.recurrence;

      const unitSel = h('select', { class: 'sel-auto', 'aria-label': 'Repeat unit',
        onchange: (e) => {
          const freq = e.target.value;
          r.frequency = freq;
          delete r.weekdays; delete r.monthly; delete r.yearly;
          if (freq === 'weekly') r.weekdays = [weekdayOf(r.startDate)];
          if (freq === 'monthly') r.monthly = { type: 'dayOfMonth', days: [Number(r.startDate.slice(8, 10))] };
          if (freq === 'yearly') r.yearly = { month: Number(r.startDate.slice(5, 7)), type: 'dayOfMonth', day: Number(r.startDate.slice(8, 10)) };
          renderRecurrence(); changed();
        } },
        [['daily', 'Days'], ['weekly', 'Weeks'], ['monthly', 'Months'], ['yearly', 'Years']].map(([v, l]) => h('option', { value: v, text: l, selected: r.frequency === v })));

      const box = h('div', { class: 'box' },
        h('div', { class: 'row', style: { marginBottom: '10px' } },
          h('span', { text: 'Every' }),
          h('input', { type: 'number', class: 'num', min: '1', value: String(r.interval), 'aria-label': 'Repeat every', oninput: (e) => { r.interval = e.target.value === '' ? NaN : Number(e.target.value); changed(); } }),
          unitSel));

      if (r.frequency === 'weekly') {
        box.appendChild(h('div', { class: 'field' }, h('div', { class: 'label', text: 'On' }), weekdayToggles(() => r.weekdays, (list) => { r.weekdays = list; })));
      }
      if (r.frequency === 'monthly') box.appendChild(h('div', { class: 'field' }, monthlyControls(r)));
      if (r.frequency === 'yearly') box.appendChild(h('div', { class: 'field' }, yearlyControls(r)));

      box.appendChild(h('div', { class: 'field' },
        h('label', { for: 'f-start-date', text: 'Starts on' }),
        h('input', { type: 'date', id: 'f-start-date', class: 'sel-auto', value: r.startDate, oninput: (e) => { r.startDate = e.target.value; f.date = e.target.value; changed(); } })));
      box.appendChild(h('div', { class: 'field' }, h('div', { class: 'label', text: 'Ends' }), endControls(r)));
      box.appendChild(ruleSummary);
      box.appendChild(rulePreview);
      recurrenceBox.appendChild(box);
    }

    // ---- reminders ----
    function renderReminders() {
      clear(remindersBox);
      const rem = f.reminders;
      // The full-screen alert is independent of the reminder On/Off switch below.
      remindersBox.appendChild(
        h('div', { class: 'field' },
          h('label', { class: 'switch' },
            h('input', {
              type: 'checkbox', id: 'f-fullscreen', checked: Boolean(rem.fullScreen),
              onchange: (e) => { rem.fullScreen = e.target.checked; },
            }),
            h('span', { text: 'Full-screen alert at the start time', style: { fontWeight: '600' } })),
          h('p', {
            class: 'hint',
            text: settings.fullScreenAlerts
              ? 'At exactly the start time a full-screen reminder covers the screen until you click a button. Its look is set in Settings.'
              : 'Full-screen alerts are switched off in Settings, so this will not show until they are switched on there.',
          }))
      );
      remindersBox.appendChild(
        h('div', { class: 'field' },
          h('div', { class: 'label', text: 'Reminder' }),
          h('div', { class: 'segmented', role: 'group', 'aria-label': 'Reminder on or off' },
            h('button', { type: 'button', class: rem.enabled ? '' : 'on', text: 'Off', onclick: () => { rem.enabled = false; renderReminders(); } }),
            h('button', { type: 'button', class: rem.enabled ? 'on' : '', text: 'On', onclick: () => { rem.enabled = true; renderReminders(); } })))
      );
      if (!rem.enabled) return;

      const chips = h('div', { class: 'chips' });
      rem.offsets.slice().sort((a, b) => b - a).forEach((n) =>
        chips.appendChild(h('span', { class: 'chip' }, h('span', { text: offsetLabel(n) }),
          h('button', { type: 'button', 'aria-label': `Remove ${offsetLabel(n)}`, text: '✕', onclick: () => { rem.offsets = rem.offsets.filter((o) => o !== n); renderReminders(); } }))));
      remindersBox.appendChild(chips);
      if (rem.offsets.length === 0) {
        remindersBox.appendChild(h('p', { class: 'hint', text: `No custom times: the default reminder (${offsetLabel(settings.defaultReminderOffsetMinutes).toLowerCase()}) will be used.` }));
      }

      const amount = h('input', { type: 'number', class: 'num', min: '0', value: '15', 'aria-label': 'Reminder amount' });
      const unit = h('select', { class: 'sel-auto', 'aria-label': 'Reminder unit' },
        h('option', { value: '1', text: 'minutes' }), h('option', { value: '60', text: 'hours' }), h('option', { value: '1440', text: 'days' }));
      remindersBox.appendChild(h('div', { class: 'row' },
        amount, unit, h('span', { text: 'before the start' }),
        h('button', {
          type: 'button', class: 'btn small', text: 'Add reminder',
          onclick: () => {
            const minutes = Number(amount.value) * Number(unit.value);
            if (!Number.isInteger(minutes) || minutes < 0) { DP.toast('Please enter a whole number of 0 or more.', 'error'); return; }
            if (!rem.offsets.includes(minutes)) rem.offsets.push(minutes);
            renderReminders();
          },
        }),
        h('button', { type: 'button', class: 'btn small', text: 'At start time', onclick: () => { if (!rem.offsets.includes(0)) rem.offsets.push(0); renderReminders(); } })));
    }

    // ---- assemble ----
    renderStart(); renderDate(); renderRecurrence(); renderReminders();

    const prioritySel = h('select', { id: 'f-priority', onchange: (e) => { f.priority = e.target.value; } },
      ['Low', 'Medium', 'High'].map((p) => h('option', { value: p, text: p, selected: f.priority === p })));
    const categorySel = h('select', { id: 'f-category', onchange: (e) => { f.categoryId = e.target.value || null; } },
      h('option', { value: '', text: 'No category' }),
      DP.state.categories.map((c) => h('option', { value: c.id, text: c.name, selected: f.categoryId === c.id })));
    const notes = h('textarea', { id: 'f-notes', 'aria-label': 'Notes', value: f.notes, oninput: (e) => { f.notes = e.target.value; } });

    dlg.body.append(
      errorsBox,
      h('div', { class: 'field' }, h('label', { for: 'f-title', text: 'Title' }), titleInput),
      h('div', { class: 'field' }, h('div', { class: 'label', text: 'Start Time' }), startBox,
        h('div', { class: 'row', style: { marginTop: '10px' } }, h('span', { class: 'hint', text: 'Starts at' }), startReadout),
        startWarning),
      h('div', { class: 'field' }, h('div', { class: 'label', text: 'Duration' }),
        h('div', { class: 'row' }, hoursInput, h('span', { text: 'h' }), minutesInput, h('span', { text: 'min' }),
          h('span', { class: 'hint', text: 'Ends at' }), endReadout)),
      h('div', { class: 'field' }, h('div', { class: 'label', text: 'Zone (set automatically)' }), zoneReadout, placementNote),
      dateBox,
      recurrenceBox,
      remindersBox,
      h('div', { class: 'row', style: { alignItems: 'flex-start' } },
        h('div', { class: 'field grow' }, h('label', { for: 'f-priority', text: 'Priority' }), prioritySel),
        h('div', { class: 'field grow' }, h('label', { for: 'f-category', text: 'Category' }), categorySel)),
      h('div', { class: 'field' }, h('label', { for: 'f-notes', text: 'Notes' }), notes)
    );

    // ---- buttons ----
    const saveBtn = h('button', { class: 'btn primary', text: 'Save' });
    if (isEdit) {
      dlg.footer.append(
        h('button', { class: 'btn danger', text: 'Delete', onclick: onDelete }),
        h('button', { class: 'btn', text: 'Duplicate', onclick: onDuplicate }),
        h('span', { class: 'spacer' })
      );
    }
    dlg.footer.append(h('button', { class: 'btn', text: 'Cancel', onclick: () => dlg.close() }), saveBtn);

    async function onSave() {
      f.title = titleInput.value;
      const p = await DP.call('previewForm', f, { taskId: options.taskId || null });
      const problems = p.errors.slice();
      if (f.title.trim() === '') problems.unshift('Please enter a title');
      if (problems.length) {
        showErrors(problems);
        dlg.body.scrollTop = 0;
        errorsBox.scrollIntoView({ block: 'nearest' });
        return;
      }
      let scope = 'all';
      if (isEdit && info.isRecurring && f.recurrence) {
        const ruleChanged = JSON.stringify(f.recurrence) !== originalRule;
        scope = await DP.askScope({ title: 'Save changes', verb: 'Save', allowThis: !ruleChanged });
        if (scope === null) return;
      }
      saveBtn.disabled = true;
      try {
        await DP.call('saveTask', { mode: options.mode, taskId: options.taskId, dateKey: options.dateKey, scope, form: f });
        dlg.close();
        DP.toast(isEdit ? 'Task saved' : 'Task added');
        DP.afterChange();
      } catch (error) {
        showErrors([error.message]);
        saveBtn.disabled = false;
      }
    }
    saveBtn.addEventListener('click', onSave);

    async function onDelete() {
      let scope = 'all';
      if (info.isRecurring) {
        scope = await DP.askScope({ title: 'Delete task', verb: 'Delete', allowThis: true });
        if (scope === null) return;
      }
      try {
        const impact = await DP.call('getDeleteImpact', { taskId: options.taskId, dateKey: options.dateKey, scope });
        if (impact.wholeTask && impact.dependents.length > 0) {
          const names = impact.dependents.map((d) => `“${d.title}”`).join(', ');
          const go = await DP.ask({
            title: 'Other tasks follow this task',
            message: `These tasks start relative to “${f.title}”: ${names}. If you delete it, they stay at the times they have now, as fixed times.`,
            choices: [{ label: 'Cancel', value: false }, { label: 'Delete anyway', value: true, kind: 'danger' }],
          });
          if (!go) return;
        } else if (!info.isRecurring) {
          const answer = await DP.ask({
            title: 'Delete task', message: `Delete "${f.title}"?`,
            choices: [{ label: 'Cancel', value: false }, { label: 'Delete', value: true, kind: 'danger' }],
          });
          if (!answer) return;
        }
        const result = await DP.call('deleteTask', { taskId: options.taskId, dateKey: options.dateKey, scope });
        dlg.close();
        const inexact = (result.frozen || []).filter((t) => !t.exact);
        DP.toast(inexact.length
          ? `Task deleted. “${inexact.map((t) => t.title).join('”, “')}” could not keep its exact time and uses its backup time.`
          : 'Task deleted');
        DP.afterChange();
      } catch (error) {
        showErrors([error.message]);
      }
    }

    async function onDuplicate() {
      try {
        await DP.call('duplicateTask', { taskId: options.taskId });
        dlg.close();
        DP.toast('Task duplicated');
        DP.afterChange();
      } catch (error) {
        showErrors([error.message]);
      }
    }

    titleInput.focus();
    refreshPreview();
  };
})();
