'use strict';

// Task model + occurrence generation.
//
// A task is plain data:
//   {
//     id, title,
//     start: { mode: 'fixed', time: '09:00' }
//          | { mode: 'prayer', prayer: 'asr', direction: 'after', minutes: 10 },
//     durationMinutes,
//     date,                // one-off tasks: calendar date of the start ('2026-10-05'); recurring: null
//     recurrence,          // null, or a rule (see recurrence.js)
//     reminders: { enabled, offsets: [15, 0] },
//     priority: 'Low' | 'Medium' | 'High', categoryId, notes,
//     exceptions: ['2026-11-13'],            // excluded occurrence dates
//     additions: ['2026-11-14'],             // extra one-off occurrence dates
//     overrides: { '2026-10-09': { start: {...} } },   // single-occurrence edits
//     completions: { '2026-10-02': true }    // done / not done PER occurrence
//   }
//
// Derived values (end time, zone, occurrences) are never stored on the task.
// Every function here returns NEW objects; nothing is changed in place.

const {
  isValidKey,
  addDaysToKey,
  keyToDayNumber,
  parseDateKey,
  formatKeyShort,
} = require('./time');
const {
  PRAYERS,
  getBoundaries,
  deriveZone,
  resolvePrayerRelative,
  computeEnd,
} = require('./zones');
const { normalizeRule, validateRule, generateDates } = require('./recurrence');

const PRIORITIES = ['Low', 'Medium', 'High'];
const SCOPES = ['this', 'following', 'all'];
const EDITABLE_FIELDS = ['title', 'start', 'durationMinutes', 'notes', 'priority', 'categoryId', 'reminders'];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// ---- Validation --------------------------------------------------------------------------

function validateStart(start) {
  if (!start || typeof start !== 'object') return ['Start time is missing'];
  if (start.mode === 'fixed') {
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(start.time || '') ? [] : ['Start time must look like 09:00'];
  }
  if (start.mode === 'prayer') {
    const errors = [];
    if (!PRAYERS.includes(start.prayer)) errors.push('Choose a prayer (Fajr, Dhuhr, Asr, Maghrib or Isha)');
    if (start.direction !== 'before' && start.direction !== 'after') errors.push('Choose Before or After the prayer');
    if (!Number.isInteger(start.minutes) || start.minutes < 0) errors.push('Minutes must be a whole number, 0 or more');
    return errors;
  }
  return ['Start time must be a fixed time or relative to a prayer'];
}

function validateDuration(minutes) {
  return Number.isInteger(minutes) && minutes > 0 ? [] : ['Duration must be a whole number of minutes, more than 0'];
}

function validateReminders(reminders) {
  if (!reminders) return [];
  const offsets = reminders.offsets || [];
  if (!Array.isArray(offsets) || !offsets.every((o) => Number.isInteger(o) && o >= 0)) {
    return ['Reminder times must be whole minutes, 0 or more'];
  }
  return [];
}

function validateTask(task) {
  const errors = [];
  if (!task || typeof task.id !== 'string' || task.id === '') errors.push('Task needs an id');
  if (!task || typeof task.title !== 'string' || task.title.trim() === '') errors.push('Please enter a title');
  if (!task) return errors;
  errors.push(...validateStart(task.start));
  errors.push(...validateDuration(task.durationMinutes));
  errors.push(...validateReminders(task.reminders));
  if (!PRIORITIES.includes(task.priority)) errors.push('Priority must be Low, Medium or High');
  if (task.recurrence) {
    errors.push(...validateRule(task.recurrence));
  } else if (!isValidKey(task.date)) {
    errors.push('Please choose a date');
  }
  return errors;
}

function assertValid(task) {
  const errors = validateTask(task);
  if (errors.length) throw new Error(errors.join('; '));
  return task;
}

function createTask(input) {
  const recurrence = input.recurrence ? normalizeRule(input.recurrence) : null;
  const task = {
    id: input.id,
    title: String(input.title === undefined || input.title === null ? '' : input.title).trim(),
    start: input.start,
    durationMinutes: input.durationMinutes,
    date: recurrence ? null : input.date,
    recurrence,
    reminders: input.reminders || { enabled: false, offsets: [] },
    priority: input.priority || 'Medium',
    categoryId: input.categoryId === undefined ? null : input.categoryId,
    notes: input.notes || '',
    exceptions: [],
    additions: [],
    overrides: {},
    completions: {},
  };
  return assertValid(task);
}

// ---- Occurrences ---------------------------------------------------------------------------

// Resolve the actual start moment of a start-time definition on a calendar date.
function startAtDate(provider, start, dateKey) {
  if (start.mode === 'fixed') {
    const [h, m] = start.time.split(':').map(Number);
    const d = parseDateKey(dateKey);
    d.setHours(h, m, 0, 0);
    return d;
  }
  if (start.mode === 'prayer') {
    return resolvePrayerRelative(provider, dateKey, start);
  }
  throw new Error(`Unknown start mode: ${start.mode}`);
}

// Calendar dates on which the task occurs between fromKey and toKey (inclusive).
// Returns [{ dateKey, isAddition }].
function expandDates(task, fromKey, toKey, options = {}) {
  const inRange = (key) => key >= fromKey && key <= toKey;
  const result = new Map();

  if (task.recurrence) {
    const excluded = new Set(task.exceptions);
    for (const key of generateDates(task.recurrence, fromKey, toKey, options)) {
      if (!excluded.has(key)) result.set(key, false);
    }
  } else if (task.date && inRange(task.date)) {
    result.set(task.date, false);
  }

  for (const key of task.additions) {
    if (inRange(key) && !result.has(key)) result.set(key, true);
  }

  return Array.from(result.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([dateKey, isAddition]) => ({ dateKey, isAddition }));
}

function buildOccurrence(provider, task, dateKey, isAddition = false) {
  const override = task.overrides[dateKey] || {};
  const merged = {
    title: task.title,
    start: task.start,
    durationMinutes: task.durationMinutes,
    notes: task.notes,
    priority: task.priority,
    categoryId: task.categoryId,
    reminders: task.reminders,
    ...override,
  };
  const start = startAtDate(provider, merged.start, dateKey);
  const end = computeEnd(start, merged.durationMinutes);
  return {
    id: `${task.id}@${dateKey}`,
    taskId: task.id,
    dateKey, // calendar date of the occurrence (NOT necessarily its Planning Day)
    title: merged.title,
    notes: merged.notes,
    priority: merged.priority,
    categoryId: merged.categoryId,
    reminders: merged.reminders,
    startDefinition: merged.start,
    durationMinutes: merged.durationMinutes,
    start,
    end,
    done: Boolean(task.completions[dateKey]),
    isRecurring: Boolean(task.recurrence),
    isAddition,
    isOverridden: Object.keys(override).length > 0,
  };
}

function getOccurrences(provider, task, fromKey, toKey, options = {}) {
  return expandDates(task, fromKey, toKey, options).map(({ dateKey, isAddition }) =>
    buildOccurrence(provider, task, dateKey, isAddition)
  );
}

// Every occurrence that touches a Planning Day (including ones that began in the
// previous Planning Day and are still running at this day's Fajr). Sorted by start.
// Occurrences are listed under the Planning Day that contains their START moment.
function occurrencesForPlanningDay(provider, tasks, planningDayKey, options = {}) {
  const boundaries = getBoundaries(provider, planningDayKey);
  const from = addDaysToKey(planningDayKey, -2);
  const to = addDaysToKey(planningDayKey, 2);
  const all = tasks.flatMap((task) => getOccurrences(provider, task, from, to, options));
  return all
    .filter((o) => o.end > boundaries.fajr && o.start < boundaries.nextFajr)
    .sort((a, b) => a.start - b.start);
}

// The line the task form shows so the user knows where a task will appear, e.g.
// "Will appear under Planning Day: Oct 4 → Oct 5, Zone: Isha → Fajr".
function placementNote(provider, start, enteredDateKey) {
  const derived = deriveZone(provider, start);
  const endKey = addDaysToKey(derived.planningDayKey, 1);
  return {
    planningDayKey: derived.planningDayKey,
    planningDayEndKey: endKey,
    zoneIndex: derived.zoneIndex,
    zoneName: derived.zoneName,
    differsFromDate: derived.planningDayKey !== enteredDateKey,
    text: `Will appear under Planning Day: ${formatKeyShort(derived.planningDayKey)} → ${formatKeyShort(endKey)}, Zone: ${derived.zoneName}`,
  };
}

// ---- Completion and one-off additions ----------------------------------------------------------

function setCompletion(task, dateKey, done) {
  const updated = clone(task);
  if (done) updated.completions[dateKey] = true;
  else delete updated.completions[dateKey];
  return updated;
}

function addOccurrence(task, dateKey) {
  if (!isValidKey(dateKey)) throw new Error('Please choose a valid date');
  const updated = clone(task);
  updated.exceptions = updated.exceptions.filter((k) => k !== dateKey);
  if (!updated.additions.includes(dateKey)) updated.additions.push(dateKey);
  updated.additions.sort();
  return updated;
}

// ---- Edit and delete with scope (This occurrence / This and following / All) -------------------

function pickFields(patch) {
  const fields = {};
  for (const key of EDITABLE_FIELDS) {
    if (key in patch) fields[key] = patch[key];
  }
  return fields;
}

function checkPatch(fields) {
  const errors = [];
  if ('title' in fields && String(fields.title).trim() === '') errors.push('Please enter a title');
  if ('start' in fields) errors.push(...validateStart(fields.start));
  if ('durationMinutes' in fields) errors.push(...validateDuration(fields.durationMinutes));
  if ('reminders' in fields) errors.push(...validateReminders(fields.reminders));
  if ('priority' in fields && !PRIORITIES.includes(fields.priority)) errors.push('Priority must be Low, Medium or High');
  if (errors.length) throw new Error(errors.join('; '));
}

function atOrAfter(key, dateKey) {
  return keyToDayNumber(key) >= keyToDayNumber(dateKey);
}

function before(key, dateKey) {
  return keyToDayNumber(key) < keyToDayNumber(dateKey);
}

function filterMap(obj, predicate) {
  const out = {};
  for (const key of Object.keys(obj)) {
    if (predicate(key)) out[key] = obj[key];
  }
  return out;
}

// A new value for a field replaces single-occurrence edits of that same field.
function dropOverriddenFields(overrides, fields) {
  const out = {};
  for (const date of Object.keys(overrides)) {
    const kept = {};
    for (const field of Object.keys(overrides[date])) {
      if (!(field in fields)) kept[field] = overrides[date][field];
    }
    if (Object.keys(kept).length > 0) out[date] = kept;
  }
  return out;
}

// Returns { updated, created }. `created` is only set by "following" edits (a new task that
// carries the changed schedule forward) and needs options.newId.
function editTask(task, scope, dateKey, patch, options = {}) {
  if (!SCOPES.includes(scope)) throw new Error(`Unknown edit scope: ${scope}`);
  const fields = pickFields(patch);
  checkPatch(fields);

  // One-off task: just edit it.
  if (!task.recurrence) {
    const updated = { ...clone(task), ...clone(fields) };
    if ('date' in patch) updated.date = patch.date;
    return { updated: assertValid(updated), created: null };
  }

  if (scope === 'this') {
    if ('recurrence' in patch) throw new Error('The repeat pattern cannot be changed for a single occurrence');
    const updated = clone(task);
    updated.overrides[dateKey] = { ...(updated.overrides[dateKey] || {}), ...clone(fields) };
    return { updated: assertValid(updated), created: null };
  }

  const rule = normalizeRule(task.recurrence);
  const isFirst = keyToDayNumber(dateKey) <= keyToDayNumber(rule.startDate);

  if (scope === 'all' || isFirst) {
    const updated = { ...clone(task), ...clone(fields) };
    if (patch.recurrence) updated.recurrence = normalizeRule(patch.recurrence);
    updated.overrides = dropOverriddenFields(task.overrides, fields);
    return { updated: assertValid(updated), created: null };
  }

  // scope === 'following': split the task at dateKey.
  if (!options.newId) throw new Error('Editing "this and following" needs a new task id');
  const dayBefore = addDaysToKey(dateKey, -1);
  const occurrencesBefore = generateDates(rule, rule.startDate, dayBefore, options).length;

  const originalRule = { ...rule, end: { type: 'date', date: dayBefore } };

  let newRule;
  if (patch.recurrence) {
    newRule = { ...normalizeRule(patch.recurrence), startDate: dateKey };
  } else {
    newRule = { ...rule, startDate: dateKey };
    if (rule.end.type === 'count') {
      newRule.end = { type: 'count', count: rule.end.count - occurrencesBefore };
    }
  }

  const updated = clone(task);
  updated.recurrence = originalRule;
  updated.exceptions = task.exceptions.filter((k) => before(k, dateKey));
  updated.additions = task.additions.filter((k) => before(k, dateKey));
  updated.overrides = filterMap(task.overrides, (k) => before(k, dateKey));
  updated.completions = filterMap(task.completions, (k) => before(k, dateKey));

  const created = { ...clone(task), ...clone(fields) };
  created.id = options.newId;
  created.date = null;
  created.recurrence = newRule;
  created.exceptions = task.exceptions.filter((k) => atOrAfter(k, dateKey));
  created.additions = task.additions.filter((k) => atOrAfter(k, dateKey));
  created.overrides = dropOverriddenFields(
    filterMap(task.overrides, (k) => atOrAfter(k, dateKey)),
    fields
  );
  created.completions = filterMap(task.completions, (k) => atOrAfter(k, dateKey));

  return { updated: assertValid(updated), created: assertValid(created) };
}

// Returns the changed task, or null when the whole task is deleted.
function deleteOccurrences(task, scope, dateKey, options = {}) {
  if (!SCOPES.includes(scope)) throw new Error(`Unknown delete scope: ${scope}`);
  if (!task.recurrence || scope === 'all') return null;

  const rule = normalizeRule(task.recurrence);

  if (scope === 'this') {
    const updated = clone(task);
    updated.additions = updated.additions.filter((k) => k !== dateKey);
    if (generateDates(rule, dateKey, dateKey, options).length > 0 && !updated.exceptions.includes(dateKey)) {
      updated.exceptions.push(dateKey);
      updated.exceptions.sort();
    }
    delete updated.overrides[dateKey];
    delete updated.completions[dateKey];
    return updated;
  }

  // following
  if (keyToDayNumber(dateKey) <= keyToDayNumber(rule.startDate)) return null;
  const updated = clone(task);
  updated.recurrence = { ...rule, end: { type: 'date', date: addDaysToKey(dateKey, -1) } };
  updated.exceptions = task.exceptions.filter((k) => before(k, dateKey));
  updated.additions = task.additions.filter((k) => before(k, dateKey));
  updated.overrides = filterMap(task.overrides, (k) => before(k, dateKey));
  updated.completions = filterMap(task.completions, (k) => before(k, dateKey));
  return updated;
}

module.exports = {
  PRIORITIES,
  SCOPES,
  validateStart,
  validateTask,
  createTask,
  startAtDate,
  expandDates,
  buildOccurrence,
  getOccurrences,
  occurrencesForPlanningDay,
  placementNote,
  setCompletion,
  addOccurrence,
  editTask,
  deleteOccurrences,
};
