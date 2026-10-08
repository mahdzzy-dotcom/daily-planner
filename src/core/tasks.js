'use strict';

// Task model + occurrence generation.
//
// A task is plain data:
//   {
//     id, title,
//     start: { mode: 'fixed', time: '09:00' }
//          | { mode: 'prayer', prayer: 'asr', direction: 'after', minutes: 10 }
//          | { mode: 'task', taskId: 'abc', point: 'end', direction: 'after', minutes: 15, fallbackTime: '09:00' },
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
  addMinutes,
  keyToDayNumber,
  parseDateKey,
  formatKeyShort,
  dateKey: dateKeyOf,
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
  if (start.mode === 'task') {
    const errors = [];
    if (typeof start.taskId !== 'string' || start.taskId === '') errors.push('Choose the task this one should follow');
    if (start.point !== 'start' && start.point !== 'end') errors.push('Choose the start or the end of that task');
    if (start.direction !== 'before' && start.direction !== 'after') errors.push('Choose Before or After that task');
    if (!Number.isInteger(start.minutes) || start.minutes < 0) errors.push('Minutes must be a whole number, 0 or more');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start.fallbackTime || '')) errors.push('Choose a backup start time');
    return errors;
  }
  return ['Start time must be a fixed time, relative to a prayer, or relative to another task'];
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
  if ('fullScreen' in reminders && typeof reminders.fullScreen !== 'boolean') {
    return ['The full-screen alert must be on or off'];
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

const MAX_CHAIN = 25;
const WARNINGS = {
  missing: 'The task it follows is not on this day, so the backup start time is used.',
  loop: 'This task and the one it follows depend on each other, so the backup start time is used.',
  inherited: 'A task earlier in this chain is not on this day, so this time is based on its backup start time.',
};

function fallbackStart(start, dateKey, warning) {
  const [h, m] = start.fallbackTime.split(':').map(Number);
  const d = parseDateKey(dateKey);
  d.setHours(h, m, 0, 0);
  return { start: d, warning, followsTaskId: start.taskId };
}

// Tasks that were split off an earlier task by "This and following" edits continue its schedule.
function referenceCandidates(tasks, taskId) {
  const ids = [taskId];
  for (let i = 0; i < ids.length && ids.length < 50; i++) {
    for (const t of tasks) if (t.continuedFrom === ids[i] && !ids.includes(t.id)) ids.push(t.id);
  }
  return ids;
}

function findReferenceOccurrence(provider, tasks, taskId, dateKey, context) {
  for (const id of referenceCandidates(tasks, taskId)) {
    const task = tasks.find((t) => t.id === id);
    if (!task) continue;
    const dates = expandDates(task, dateKey, dateKey, context);
    if (dates.length > 0) return buildOccurrence(provider, task, dateKey, dates[0].isAddition, context);
  }
  return null;
}

// Works out the actual start moment of a start definition on a calendar date.
// Returns { start: Date, warning: null | text, followsTaskId }.
// context: { tasks, workingDays, visiting } - `tasks` is needed for "relative to a task".
function resolveStart(provider, start, dateKey, context = {}, ownerId = null) {
  if (start.mode === 'fixed') {
    const [h, m] = start.time.split(':').map(Number);
    const d = parseDateKey(dateKey);
    d.setHours(h, m, 0, 0);
    return { start: d, warning: null, followsTaskId: null };
  }
  if (start.mode === 'prayer') {
    return { start: resolvePrayerRelative(provider, dateKey, start), warning: null, followsTaskId: null };
  }
  if (start.mode === 'task') {
    const visiting = new Set(context.visiting || []);
    if (ownerId) visiting.add(ownerId);
    if (visiting.has(start.taskId) || visiting.size > MAX_CHAIN) return fallbackStart(start, dateKey, WARNINGS.loop);
    const reference = findReferenceOccurrence(provider, context.tasks || [], start.taskId, dateKey, {
      ...context,
      visiting,
    });
    if (!reference) return fallbackStart(start, dateKey, WARNINGS.missing);
    const base = start.point === 'start' ? reference.start : reference.end;
    const minutes = start.direction === 'before' ? -start.minutes : start.minutes;
    // If the task it follows had to use a backup time, say so here too.
    let warning = null;
    if (reference.startWarning) warning = reference.startWarning === WARNINGS.loop ? WARNINGS.loop : WARNINGS.inherited;
    return { start: addMinutes(base, minutes), warning, followsTaskId: start.taskId };
  }
  throw new Error(`Unknown start mode: ${start.mode}`);
}

// Just the start moment (see resolveStart).
function startAtDate(provider, start, dateKey, context = {}) {
  return resolveStart(provider, start, dateKey, context).start;
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

function buildOccurrence(provider, task, dateKey, isAddition = false, context = {}) {
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
  const resolved = resolveStart(provider, merged.start, dateKey, context, task.id);
  const start = resolved.start;
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
    startWarning: resolved.warning,
    followsTaskId: resolved.followsTaskId,
  };
}

function getOccurrences(provider, task, fromKey, toKey, options = {}) {
  return expandDates(task, fromKey, toKey, options).map(({ dateKey, isAddition }) =>
    buildOccurrence(provider, task, dateKey, isAddition, options)
  );
}

// Every occurrence that touches a Planning Day (including ones that began in the
// previous Planning Day and are still running at this day's Fajr). Sorted by start.
// Occurrences are listed under the Planning Day that contains their START moment.
function occurrencesForPlanningDay(provider, tasks, planningDayKey, options = {}) {
  const boundaries = getBoundaries(provider, planningDayKey);
  const from = addDaysToKey(planningDayKey, -2);
  const to = addDaysToKey(planningDayKey, 2);
  const context = { ...options, tasks };
  const all = tasks.flatMap((task) => getOccurrences(provider, task, from, to, context));
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
  created.continuedFrom = task.id; // tasks that follow the original keep following the later part
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

// ---- Tasks that follow other tasks ------------------------------------------------------------------------

// The ids of the tasks this task follows (in its normal start time and in single-occurrence edits).
function referencedTaskIds(task) {
  const ids = new Set();
  const add = (start) => {
    if (start && start.mode === 'task') ids.add(start.taskId);
  };
  add(task.start);
  for (const key of Object.keys(task.overrides || {})) add(task.overrides[key].start);
  return ids;
}

// The tasks that follow the given task.
function findDependents(tasks, taskId) {
  return tasks.filter((t) => t.id !== taskId && referencedTaskIds(t).has(taskId));
}

// A friendly message if `task` (about to be saved) follows a missing task, itself, or would
// create a circle of tasks following each other. Otherwise null.
function dependencyProblem(tasks, task) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  byId.set(task.id, task);
  for (const refId of referencedTaskIds(task)) {
    if (refId === task.id) return 'A task cannot start relative to itself.';
    if (!byId.has(refId)) return 'The task this one follows no longer exists. Please choose another.';
  }
  const visiting = new Set();
  const finished = new Set();
  const loops = (id) => {
    if (visiting.has(id)) return true;
    if (finished.has(id)) return false;
    visiting.add(id);
    const t = byId.get(id);
    if (t) {
      for (const ref of referencedTaskIds(t)) {
        if (loops(ref)) return true;
      }
    }
    visiting.delete(id);
    finished.add(id);
    return false;
  };
  if (loops(task.id)) return 'These tasks would follow each other in a circle. Please choose a different task to follow.';
  return null;
}

// True when `candidateId` follows `taskId` directly or through other tasks.
function followsTransitively(tasks, candidateId, taskId) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const seen = new Set();
  const walk = (id) => {
    if (id === taskId) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    const t = byId.get(id);
    return t ? Array.from(referencedTaskIds(t)).some(walk) : false;
  };
  return walk(candidateId);
}

function clockText(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

// A task that is being deleted completely: the tasks following it keep the times they have now,
// as fixed times. `tasks` must still contain the deleted task. Returns
// { tasks: the list without the deleted task, frozen: [{ taskId, title, exact }] }.
// exact is false when the exact time cannot be written as a fixed time (the task crosses midnight),
// in which case its backup time is used.
function freezeDependents(provider, tasks, deletedId, dateKey, options = {}) {
  const context = { ...options, tasks };
  const frozen = [];

  // The clock time an occurrence has now, as a fixed start (or null when it cannot be kept exactly).
  const fixedFor = (task, key) => {
    const occurrence = buildOccurrence(provider, task, key, false, context);
    if (occurrence.startWarning) return null;
    if (dateKeyOf(occurrence.start) !== key) return null;
    return { mode: 'fixed', time: clockText(occurrence.start) };
  };

  const updated = tasks
    .filter((t) => t.id !== deletedId)
    .map((task) => {
      if (!referencedTaskIds(task).has(deletedId)) return task;
      const copy = clone(task);
      let exact = true;
      const freeze = (def, key) => {
        const fixed = key ? fixedFor(task, key) : null;
        if (fixed) return fixed;
        exact = false;
        return { mode: 'fixed', time: def.fallbackTime };
      };

      if (copy.start.mode === 'task' && copy.start.taskId === deletedId) {
        // Use the first occurrence on or after the deleted day (or the deleted day itself).
        const window = expandDates(task, dateKey, addDaysToKey(dateKey, 366), context);
        copy.start = freeze(copy.start, window.length ? window[0].dateKey : null);
      }
      for (const key of Object.keys(copy.overrides)) {
        const def = copy.overrides[key].start;
        if (def && def.mode === 'task' && def.taskId === deletedId) copy.overrides[key].start = freeze(def, key);
      }
      frozen.push({ taskId: task.id, title: task.title, exact });
      return copy;
    });

  return { tasks: updated, frozen };
}

module.exports = {
  PRIORITIES,
  SCOPES,
  validateStart,
  validateTask,
  createTask,
  startAtDate,
  resolveStart,
  referencedTaskIds,
  findDependents,
  dependencyProblem,
  followsTransitively,
  freezeDependents,
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
