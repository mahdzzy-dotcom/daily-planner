'use strict';

// The planner "service": every action the screens can ask for, in plain Node code.
// It has no Electron in it, so it is tested directly and used by the screenshot tool.
// Everything it returns is plain data (text, numbers, lists) that can cross into the window.

const crypto = require('crypto');
const core = require('../core');

const {
  CITIES, findCity, METHOD_KEYS, METHOD_LABELS,
  mergeSettings, buildExport, parseImport,
  createTask, validateTask, validateStart, validateRule, normalizeRule, describeRule, previewDates,
  occurrencesForPlanningDay, computeDayLayout, currentPlanningDayKey, getOccurrences, buildOccurrence,
  startAtDate, computeEnd, placementNote, setCompletion, editTask, deleteOccurrences,
  remindersInWindow, reminderOffsets, createPrayerProvider,
  addDaysToKey, dateKey, formatTime12, formatDuration, formatKeyShort, weekdayOfKey, parseDateKey, isValidKey,
} = core;

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const EDIT_FIELDS = ['title', 'start', 'durationMinutes', 'notes', 'priority', 'categoryId', 'reminders'];

function defaultProviderFactory(settings) {
  const city = findCity(settings.cityName);
  return createPrayerProvider({
    latitude: city.latitude,
    longitude: city.longitude,
    method: settings.method,
    adjustments: settings.adjustments,
  });
}

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

class PlannerService {
  // deps: { store, now, newId, providerFactory, onDataChanged(), onSettingsChanged(settings) }
  constructor(deps) {
    this.store = deps.store;
    this.now = deps.now || (() => new Date());
    this.newId = deps.newId || (() => crypto.randomUUID());
    this.providerFactory = deps.providerFactory || defaultProviderFactory;
    this.onDataChanged = deps.onDataChanged || (() => {});
    this.onSettingsChanged = deps.onSettingsChanged || (() => {});
    this.data = this.store.load();
    this.providerCache = null;
  }

  // ---- basics -----------------------------------------------------------------------------------------

  get settings() {
    return this.data.settings;
  }

  provider() {
    const s = this.settings;
    const key = JSON.stringify([s.cityName, s.method, s.adjustments]);
    if (!this.providerCache || this.providerCache.key !== key) {
      this.providerCache = { key, provider: this.providerFactory(s) };
    }
    return this.providerCache.provider;
  }

  recurrenceOptions() {
    return { workingDays: this.settings.workingDays };
  }

  persist() {
    this.store.save(this.data);
  }

  changed() {
    this.persist();
    this.onDataChanged();
  }

  findTask(taskId) {
    const task = this.data.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error('This task no longer exists.');
    return task;
  }

  categoryOf(categoryId) {
    return this.data.categories.find((c) => c.id === categoryId) || null;
  }

  // ---- start-up information ----------------------------------------------------------------------------

  bootstrap() {
    return {
      settings: copy(this.settings),
      categories: copy(this.data.categories),
      cities: CITIES.map((c) => c.name),
      methods: METHOD_KEYS.map((key) => ({ key, label: METHOD_LABELS[key] })),
      currentPlanningDayKey: currentPlanningDayKey(this.provider(), this.now()),
      loadNotes: copy(this.store.loadNotes || []),
    };
  }

  // ---- the Daily View -----------------------------------------------------------------------------------

  hijriLabel(key) {
    try {
      const noon = parseDateKey(key);
      noon.setHours(12, 0, 0, 0);
      noon.setDate(noon.getDate() + this.settings.hijriAdjustment);
      return new Intl.DateTimeFormat('en-US-u-ca-islamic-umalqura-nu-latn', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      }).format(noon);
    } catch (error) {
      return '';
    }
  }

  viewOccurrence(o, planningKey, nowDate) {
    const category = this.categoryOf(o.categoryId);
    return {
      id: o.id,
      taskId: o.taskId,
      dateKey: o.dateKey,
      title: o.title,
      notes: o.notes,
      priority: o.priority,
      categoryName: category ? category.name : '',
      categoryColor: category ? category.color : '',
      startLabel: formatTime12(o.start),
      endLabel: formatTime12(o.end),
      endsNextDay: dateKey(o.end) !== dateKey(o.start),
      afterMidnight: dateKey(o.start) !== planningKey,
      durationMinutes: o.durationMinutes,
      durationLabel: formatDuration(o.durationMinutes),
      isRecurring: o.isRecurring,
      hasReminders: reminderOffsets(o.reminders, this.settings).length > 0,
      done: o.done,
      overlaps: Boolean(o.overlaps),
      extendsPastZoneEnd: Boolean(o.extendsPastZoneEnd),
      overdue: !o.done && o.end.getTime() <= nowDate.getTime(),
    };
  }

  getDay(planningKey) {
    if (!isValidKey(planningKey)) throw new Error('That date is not valid.');
    const provider = this.provider();
    const nowDate = this.now();
    const nowMs = nowDate.getTime();
    const occurrences = occurrencesForPlanningDay(provider, this.data.tasks, planningKey, this.recurrenceOptions());
    const layout = computeDayLayout(provider, planningKey, occurrences);
    const currentKey = currentPlanningDayKey(provider, nowDate);
    const endKey = addDaysToKey(planningKey, 1);

    const zones = layout.zones.map((z) => {
      const span = z.end.getTime() - z.start.getTime();
      const isCurrent = planningKey === currentKey && nowMs >= z.start.getTime() && nowMs < z.end.getTime();
      const segments = [...z.tasks, ...z.continued].map((o) => {
        const from = Math.max(o.start.getTime(), z.start.getTime());
        const to = Math.min(o.end.getTime(), z.end.getTime());
        const category = this.categoryOf(o.categoryId);
        return {
          leftPct: ((from - z.start.getTime()) / span) * 100,
          widthPct: Math.max(((to - from) / span) * 100, 0.8),
          color: category ? category.color : '',
          done: o.done,
        };
      });
      return {
        index: z.index,
        name: z.name,
        startLabel: formatTime12(z.start),
        endLabel: formatTime12(z.end),
        totalLabel: z.totalLabel,
        scheduledLabel: z.scheduledLabel,
        freeLabel: z.freeLabel,
        isCurrent,
        nowPct: isCurrent ? ((nowMs - z.start.getTime()) / span) * 100 : null,
        segments,
        tasks: z.tasks.map((o) => this.viewOccurrence(o, planningKey, nowDate)),
        continued: z.continued.map((o) => ({
          taskId: o.taskId,
          dateKey: o.dateKey,
          title: o.title,
          endLabel: formatTime12(o.end),
          minutesLabel: formatDuration(o.minutesInZone),
        })),
      };
    });

    return {
      planningDayKey: planningKey,
      prevKey: addDaysToKey(planningKey, -1),
      nextKey: endKey,
      isCurrentDay: planningKey === currentKey,
      currentPlanningDayKey: currentKey,
      dateTitle: parseDateKey(planningKey).toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      }),
      hijri: this.hijriLabel(planningKey),
      planningLine: `Planning Day: ${formatKeyShort(planningKey)} → ${formatKeyShort(endKey)}`,
      zones,
    };
  }

  // Next reminders, for the bell.
  getUpcoming() {
    const nowDate = this.now();
    const from = nowDate.getTime();
    const list = remindersInWindow(this.provider(), this.data.tasks, from, from + 7 * 86400000, this.settings).slice(0, 12);
    const todayKey = dateKey(nowDate);
    const tomorrowKey = addDaysToKey(todayKey, 1);
    return list.map((r) => {
      const k = dateKey(r.notifyAt);
      const day = k === todayKey ? 'Today' : k === tomorrowKey ? 'Tomorrow' : formatKeyShort(k);
      return {
        taskId: r.taskId,
        dateKey: r.dateKey,
        title: r.title,
        whenLabel: `${day}, ${formatTime12(r.notifyAt)}`,
        startLabel: formatTime12(r.start),
        zoneName: r.zoneName,
      };
    });
  }

  // ---- the task form ---------------------------------------------------------------------------------------

  newTaskDefaults(forKey) {
    const key = isValidKey(forKey) ? forKey : dateKey(this.now());
    return {
      title: '',
      start: { mode: 'fixed', time: '09:00' },
      durationMinutes: 30,
      date: key,
      recurrence: null,
      reminders: { enabled: true, offsets: [] }, // empty list = the default reminder time from Settings
      priority: 'Medium',
      categoryId: null,
      notes: '',
    };
  }

  getTaskForEdit({ taskId, dateKey: key }) {
    const task = this.findTask(taskId);
    const occurrence = buildOccurrence(this.provider(), task, key);
    return {
      taskId,
      dateKey: key,
      isRecurring: Boolean(task.recurrence),
      done: occurrence.done,
      form: {
        title: occurrence.title,
        start: copy(occurrence.startDefinition),
        durationMinutes: occurrence.durationMinutes,
        date: task.recurrence ? key : task.date,
        recurrence: task.recurrence ? copy(task.recurrence) : null,
        reminders: copy(occurrence.reminders),
        priority: occurrence.priority,
        categoryId: occurrence.categoryId,
        notes: occurrence.notes,
      },
    };
  }

  // Live preview shown while the form is open: resolved start, end, zone, and the repeat summary.
  previewForm(form) {
    const provider = this.provider();
    const errors = [];
    const out = { errors, resolved: null, placement: null, rule: null };

    errors.push(...validateStart(form.start));
    const durationOk = Number.isInteger(form.durationMinutes) && form.durationMinutes > 0;
    if (!durationOk) errors.push('Duration must be a whole number of minutes, more than 0');

    let contextKey = form.recurrence ? form.recurrence.startDate : form.date;
    if (!isValidKey(contextKey)) {
      errors.push(form.recurrence ? 'Please choose a start date' : 'Please choose a date');
      contextKey = null;
    }

    if (form.recurrence) {
      const ruleErrors = validateRule(form.recurrence);
      errors.push(...ruleErrors);
      if (ruleErrors.length === 0) {
        const rule = normalizeRule(form.recurrence);
        out.rule = {
          summary: describeRule(rule),
          preview: previewDates(rule, 5, this.recurrenceOptions()).map((k) => ({
            key: k,
            label: `${WEEKDAY_SHORT[weekdayOfKey(k)]}, ${formatKeyShort(k, true)}`,
          })),
        };
      }
    }

    if (contextKey && validateStart(form.start).length === 0) {
      const start = startAtDate(provider, form.start, contextKey);
      out.resolved = { startLabel: formatTime12(start), endLabel: null, endsNextDay: false };
      if (durationOk) {
        const end = computeEnd(start, form.durationMinutes);
        out.resolved.endLabel = formatTime12(end);
        out.resolved.endsNextDay = dateKey(end) !== dateKey(start);
      }
      const note = placementNote(provider, start, contextKey);
      out.placement = {
        text: note.text,
        zoneIndex: note.zoneIndex,
        zoneName: note.zoneName,
        differsFromDate: note.differsFromDate,
      };
    }
    return out;
  }

  cleanForm(form) {
    const fields = {
      title: String(form.title === undefined || form.title === null ? '' : form.title).trim(),
      start: form.start,
      durationMinutes: form.durationMinutes,
      notes: typeof form.notes === 'string' ? form.notes : '',
      priority: form.priority || 'Medium',
      categoryId: form.categoryId && this.categoryOf(form.categoryId) ? form.categoryId : null,
      reminders: {
        enabled: Boolean(form.reminders && form.reminders.enabled),
        offsets: form.reminders && Array.isArray(form.reminders.offsets) ? form.reminders.offsets : [],
      },
    };
    return { fields, recurrence: form.recurrence ? normalizeRule(form.recurrence) : null, date: form.date };
  }

  // payload: { mode: 'create' | 'edit', taskId, dateKey, scope: 'this'|'following'|'all', form }
  saveTask(payload) {
    const { fields, recurrence, date } = this.cleanForm(payload.form);

    if (payload.mode === 'create') {
      const task = createTask({ id: this.newId(), ...fields, recurrence, date });
      this.data.tasks.push(task);
      this.changed();
      return { ok: true, taskId: task.id };
    }

    const old = this.findTask(payload.taskId);
    const key = payload.dateKey;
    const scope = payload.scope || 'all';
    const wasRecurring = Boolean(old.recurrence);
    const willRecur = Boolean(recurrence);

    let updated;
    let created = null;

    if (wasRecurring !== willRecur) {
      if (scope !== 'all') {
        throw new Error('To switch between repeating and not repeating, choose "All occurrences".');
      }
      const replacement = createTask({ id: old.id, ...fields, recurrence, date });
      updated = { ...replacement, completions: copy(old.completions) };
    } else if (!wasRecurring) {
      ({ updated } = editTask(old, 'all', key, { ...fields, date }));
    } else {
      // Only the fields the user really changed are sent, so single-occurrence edits elsewhere survive.
      const current = buildOccurrence(this.provider(), old, key);
      const currentValues = {
        title: current.title,
        start: current.startDefinition,
        durationMinutes: current.durationMinutes,
        notes: current.notes,
        priority: current.priority,
        categoryId: current.categoryId,
        reminders: current.reminders,
      };
      const patch = {};
      for (const name of EDIT_FIELDS) {
        if (!same(fields[name], currentValues[name])) patch[name] = fields[name];
      }
      const ruleChanged = !same(normalizeRule(old.recurrence), recurrence);
      if (ruleChanged) {
        if (scope === 'this') {
          throw new Error('The repeat pattern can only be changed for "This and following" or "All occurrences".');
        }
        patch.recurrence = recurrence;
      }
      if (Object.keys(patch).length === 0) return { ok: true, taskId: old.id, unchanged: true };
      ({ updated, created } = editTask(old, scope, key, patch, { newId: this.newId(), ...this.recurrenceOptions() }));
    }

    this.data.tasks = this.data.tasks.map((t) => (t.id === updated.id ? updated : t));
    if (created) this.data.tasks.push(created);
    this.changed();
    return { ok: true, taskId: updated.id };
  }

  deleteTask({ taskId, dateKey: key, scope }) {
    const task = this.findTask(taskId);
    const result = deleteOccurrences(task, scope || 'all', key, this.recurrenceOptions());
    if (result === null) this.data.tasks = this.data.tasks.filter((t) => t.id !== taskId);
    else this.data.tasks = this.data.tasks.map((t) => (t.id === taskId ? result : t));
    this.changed();
    return { ok: true };
  }

  setDone({ taskId, dateKey: key, done }) {
    const task = this.findTask(taskId);
    const updated = setCompletion(task, key, Boolean(done));
    this.data.tasks = this.data.tasks.map((t) => (t.id === taskId ? updated : t));
    this.changed();
    return { ok: true };
  }

  duplicateTask({ taskId }) {
    const old = this.findTask(taskId);
    const task = createTask({
      id: this.newId(),
      title: `${old.title} (copy)`,
      start: copy(old.start),
      durationMinutes: old.durationMinutes,
      date: old.date,
      recurrence: old.recurrence ? copy(old.recurrence) : null,
      reminders: copy(old.reminders),
      priority: old.priority,
      categoryId: old.categoryId,
      notes: old.notes,
    });
    this.data.tasks.push(task);
    this.changed();
    return { ok: true, taskId: task.id };
  }

  // ---- settings and categories ---------------------------------------------------------------------------------

  getSettings() {
    return copy(this.settings);
  }

  saveSettings(patch) {
    this.data.settings = mergeSettings(this.data.settings, patch);
    this.providerCache = null;
    this.persist();
    this.onSettingsChanged(copy(this.data.settings));
    this.onDataChanged();
    return copy(this.data.settings);
  }

  validateCategory({ name, color }, ignoreId) {
    const clean = String(name || '').trim();
    if (clean === '') throw new Error('Please enter a category name.');
    if (clean.length > 40) throw new Error('Category names can be up to 40 characters.');
    if (this.data.categories.some((c) => c.id !== ignoreId && c.name.toLowerCase() === clean.toLowerCase())) {
      throw new Error('There is already a category with that name.');
    }
    if (!/^#[0-9a-fA-F]{6}$/.test(color || '')) throw new Error('Please choose a color.');
    return { name: clean, color };
  }

  addCategory(input) {
    const clean = this.validateCategory(input);
    const category = { id: `cat-${this.newId()}`, ...clean };
    this.data.categories.push(category);
    this.changed();
    return copy(this.data.categories);
  }

  updateCategory({ id, name, color }) {
    const category = this.categoryOf(id);
    if (!category) throw new Error('That category no longer exists.');
    Object.assign(category, this.validateCategory({ name, color }, id));
    this.changed();
    return copy(this.data.categories);
  }

  // Deleting a category never deletes tasks: they simply become uncategorized.
  deleteCategory({ id }) {
    this.data.categories = this.data.categories.filter((c) => c.id !== id);
    for (const task of this.data.tasks) {
      if (task.categoryId === id) task.categoryId = null;
      for (const key of Object.keys(task.overrides)) {
        if (task.overrides[key].categoryId === id) task.overrides[key].categoryId = null;
      }
    }
    this.changed();
    return copy(this.data.categories);
  }

  // ---- export / import --------------------------------------------------------------------------------------------

  exportData() {
    return buildExport(this.data, this.now());
  }

  // Replaces tasks, categories and settings with the contents of a backup.
  importData(input) {
    const { data, warnings } = parseImport(input);
    this.data = { ...data, reminderState: this.data.reminderState };
    this.providerCache = null;
    this.persist();
    this.onSettingsChanged(copy(this.data.settings));
    this.onDataChanged();
    return { ok: true, tasks: data.tasks.length, categories: data.categories.length, warnings };
  }

  // ---- used by the background reminder engine (main process) ------------------------------------------------------------

  getTasks() {
    return this.data.tasks;
  }

  getReminderSettings() {
    return this.data.settings;
  }

  updateTaskFromEngine(task) {
    this.data.tasks = this.data.tasks.map((t) => (t.id === task.id ? task : t));
    this.changed();
  }

  getReminderState() {
    return this.data.reminderState;
  }

  saveReminderState(state) {
    this.data.reminderState = state;
    this.persist();
  }
}

// The names the window is allowed to call.
const PUBLIC_METHODS = [
  'bootstrap', 'getDay', 'getUpcoming', 'newTaskDefaults', 'getTaskForEdit', 'previewForm', 'saveTask',
  'deleteTask', 'setDone', 'duplicateTask', 'getSettings', 'saveSettings', 'addCategory', 'updateCategory',
  'deleteCategory',
];

module.exports = { PlannerService, PUBLIC_METHODS, defaultProviderFactory };
