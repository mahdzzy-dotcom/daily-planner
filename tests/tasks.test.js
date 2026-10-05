'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createTask,
  validateTask,
  getOccurrences,
  occurrencesForPlanningDay,
  placementNote,
  computeDayLayout,
  setCompletion,
  addOccurrence,
  editTask,
  deleteOccurrences,
  generateDates,
  formatTime12,
} = require('../src/core');
const { at, provider, constantProvider } = require('./helpers');

const fixed = (time) => ({ mode: 'fixed', time });

function fridayTask(extra = {}) {
  return createTask({
    id: 'gym',
    title: 'Gym',
    start: fixed('09:00'),
    durationMinutes: 60,
    recurrence: { startDate: '2026-10-02', frequency: 'weekly', interval: 1, weekdays: [5] },
    ...extra,
  });
}

function dates(occurrences) {
  return occurrences.map((o) => o.dateKey);
}

function timeOf(occurrence) {
  return formatTime12(occurrence.start);
}

// ---- Task creation and validation ------------------------------------------------------------------
test('Creating a task fills in sensible defaults and stores no derived values', () => {
  const task = createTask({
    id: 'a',
    title: '  Study SQL  ',
    start: fixed('08:00'),
    durationMinutes: 90,
    date: '2026-10-04',
  });
  assert.equal(task.title, 'Study SQL');
  assert.equal(task.priority, 'Medium');
  assert.equal(task.categoryId, null);
  assert.deepEqual(task.reminders, { enabled: false, offsets: [] });
  assert.equal(task.recurrence, null);
  for (const derived of ['zone', 'end', 'endTime', 'occurrences']) {
    assert.ok(!(derived in task), `${derived} must not be stored`);
  }
});

test('Arabic titles are kept exactly', () => {
  const task = createTask({ id: 'ar', title: 'مراجعة الدرس', start: fixed('08:00'), durationMinutes: 30, date: '2026-10-04' });
  assert.equal(task.title, 'مراجعة الدرس');
});

test('Validation gives friendly messages', () => {
  const base = { id: 'x', title: 'T', start: fixed('08:00'), durationMinutes: 30, date: '2026-10-04' };
  assert.throws(() => createTask({ ...base, title: '   ' }), /title/i);
  assert.throws(() => createTask({ ...base, durationMinutes: 0 }), /Duration/);
  assert.throws(() => createTask({ ...base, durationMinutes: 12.5 }), /Duration/);
  assert.throws(() => createTask({ ...base, start: fixed('25:99') }), /Start time/);
  assert.throws(() => createTask({ ...base, start: { mode: 'prayer', prayer: 'sunrise', direction: 'after', minutes: 5 } }), /prayer/i);
  assert.throws(() => createTask({ ...base, date: undefined }), /date/i);
  assert.throws(() => createTask({ ...base, priority: 'Urgent' }), /Priority/);
  assert.throws(() => createTask({ ...base, reminders: { enabled: true, offsets: [-5] } }), /Reminder/);
  assert.throws(() => createTask({ ...base, recurrence: { startDate: '2026-10-01', frequency: 'weekly', interval: 0, weekdays: [1] } }));
  assert.deepEqual(validateTask({ ...base, priority: 'Medium', recurrence: null, reminders: { enabled: false, offsets: [] } }), []);
});

// ---- Occurrences: fixed and prayer-relative -----------------------------------------------------------
test('Occurrences get their end time from start + duration', () => {
  const task = createTask({ id: 'late', title: 'Late', start: fixed('23:30'), durationMinutes: 90, date: '2026-10-04' });
  const [o] = getOccurrences(provider, task, '2026-10-04', '2026-10-04');
  assert.equal(timeOf(o), '11:30 PM');
  assert.equal(formatTime12(o.end), '1:00 AM');
  assert.equal(o.end.getDate(), 5);
});

test('Prayer-relative recurring tasks follow each day\'s prayer time', () => {
  const task = createTask({
    id: 'p',
    title: 'After Asr',
    start: { mode: 'prayer', prayer: 'asr', direction: 'after', minutes: 10 },
    durationMinutes: 20,
    recurrence: { startDate: '2026-10-04', frequency: 'daily', interval: 1 },
  });
  const occ = getOccurrences(provider, task, '2026-10-04', '2026-10-05');
  assert.deepEqual(occ.map(timeOf), ['3:24 PM', '3:22 PM']);
});

// ---- Scenario 15: exceptions, additions, single-occurrence edits --------------------------------------------
test('15. "Every Friday except Nov 13" omits only Nov 13', () => {
  let task = fridayTask();
  task = deleteOccurrences(task, 'this', '2026-11-13');
  assert.deepEqual(dates(getOccurrences(constantProvider, task, '2026-11-01', '2026-11-30')), [
    '2026-11-06', '2026-11-20', '2026-11-27',
  ]);
  assert.deepEqual(task.exceptions, ['2026-11-13']);
  // The rule itself is untouched
  assert.equal(task.recurrence.end.type, 'never');
});

test('15b. An added one-off occurrence appears, and can be removed again', () => {
  let task = fridayTask();
  task = addOccurrence(task, '2026-11-14');
  const occ = getOccurrences(constantProvider, task, '2026-11-01', '2026-11-30');
  assert.deepEqual(dates(occ), ['2026-11-06', '2026-11-13', '2026-11-14', '2026-11-20', '2026-11-27']);
  assert.equal(occ.find((o) => o.dateKey === '2026-11-14').isAddition, true);

  task = deleteOccurrences(task, 'this', '2026-11-14');
  assert.ok(!dates(getOccurrences(constantProvider, task, '2026-11-01', '2026-11-30')).includes('2026-11-14'));
  assert.deepEqual(task.additions, []);
  assert.deepEqual(task.exceptions, [], 'removing an addition does not create an exception');
});

test('15c. Adding back an excluded date works', () => {
  let task = fridayTask();
  task = deleteOccurrences(task, 'this', '2026-11-13');
  task = addOccurrence(task, '2026-11-13');
  assert.ok(dates(getOccurrences(constantProvider, task, '2026-11-01', '2026-11-30')).includes('2026-11-13'));
});

test('15d. Editing one occurrence does not change the others', () => {
  let task = fridayTask();
  ({ updated: task } = editTask(task, 'this', '2026-10-09', {
    start: fixed('08:00'),
    durationMinutes: 30,
    notes: 'Light session',
  }));
  const occ = getOccurrences(constantProvider, task, '2026-10-02', '2026-10-16');
  assert.deepEqual(occ.map(timeOf), ['9:00 AM', '8:00 AM', '9:00 AM']);
  assert.deepEqual(occ.map((o) => o.durationMinutes), [60, 30, 60]);
  assert.deepEqual(occ.map((o) => o.isOverridden), [false, true, false]);
  assert.equal(occ[1].notes, 'Light session');
  assert.equal(occ[0].notes, '');
  assert.equal(task.start.time, '09:00', 'base task unchanged');
});

test('15e. The repeat pattern cannot be changed for one occurrence only', () => {
  const task = fridayTask();
  assert.throws(() =>
    editTask(task, 'this', '2026-10-09', {
      recurrence: { startDate: '2026-10-02', frequency: 'daily', interval: 1 },
    })
  );
});

// ---- Scenario 16: edit scope -------------------------------------------------------------------------------------
test('16. "This and following" changes only later occurrences and keeps completion history', () => {
  let task = fridayTask();
  task = setCompletion(task, '2026-10-02', true);
  task = setCompletion(task, '2026-10-09', true);

  const { updated, created } = editTask(task, 'following', '2026-10-23', { start: fixed('10:00') }, { newId: 'gym2' });

  const before = getOccurrences(constantProvider, updated, '2026-10-01', '2026-12-31');
  assert.deepEqual(dates(before), ['2026-10-02', '2026-10-09', '2026-10-16']);
  assert.ok(before.every((o) => timeOf(o) === '9:00 AM'));
  assert.deepEqual(before.map((o) => o.done), [true, true, false], 'completion history preserved');

  const after = getOccurrences(constantProvider, created, '2026-10-01', '2026-11-13');
  assert.deepEqual(dates(after), ['2026-10-23', '2026-10-30', '2026-11-06', '2026-11-13']);
  assert.ok(after.every((o) => timeOf(o) === '10:00 AM'));
  assert.equal(created.id, 'gym2');
  assert.equal(created.recurrence.startDate, '2026-10-23');
});

test('16b. Splitting a rule with a count keeps the total number of occurrences', () => {
  const task = createTask({
    id: 'mon',
    title: 'Mondays',
    start: fixed('07:00'),
    durationMinutes: 30,
    recurrence: {
      startDate: '2026-10-01',
      frequency: 'weekly',
      interval: 1,
      weekdays: [1],
      end: { type: 'count', count: 20 },
    },
  });
  const original = generateDates(task.recurrence, '2026-10-01', '2030-01-01');
  assert.equal(original.length, 20);

  const eighth = original[7]; // 2026-11-23
  const { updated, created } = editTask(task, 'following', eighth, { durationMinutes: 45 }, { newId: 'mon2' });

  const first = generateDates(updated.recurrence, '2026-10-01', '2030-01-01');
  const second = generateDates(created.recurrence, '2026-10-01', '2030-01-01');
  assert.equal(first.length, 7);
  assert.equal(second.length, 13);
  assert.deepEqual([...first, ...second], original, 'same dates, now split across two tasks');
  assert.equal(created.durationMinutes, 45);
  assert.equal(updated.durationMinutes, 30);
});

test('16c. Per-date data on or after the split moves to the new task', () => {
  let task = fridayTask();
  task = setCompletion(task, '2026-10-02', true);
  task = setCompletion(task, '2026-10-30', true);
  task = deleteOccurrences(task, 'this', '2026-11-13');
  ({ updated: task } = editTask(task, 'this', '2026-11-06', { notes: 'bring towel' }));

  const { updated, created } = editTask(task, 'following', '2026-10-23', { title: 'Gym (new)' }, { newId: 'g2' });

  assert.deepEqual(Object.keys(updated.completions), ['2026-10-02']);
  assert.deepEqual(updated.exceptions, []);
  assert.deepEqual(Object.keys(created.completions), ['2026-10-30']);
  assert.deepEqual(created.exceptions, ['2026-11-13']);
  assert.equal(created.overrides['2026-11-06'].notes, 'bring towel');
});

test('16d. "This and following" on the first occurrence behaves like "All"', () => {
  const task = fridayTask();
  const { updated, created } = editTask(task, 'following', '2026-10-02', { title: 'Gym v2' }, { newId: 'unused' });
  assert.equal(created, null);
  assert.equal(updated.title, 'Gym v2');
  assert.equal(updated.id, 'gym');
});

test('16e. "This and following" needs a new id', () => {
  assert.throws(() => editTask(fridayTask(), 'following', '2026-10-23', { title: 'x' }), /new task id/);
});

test('16f. Changing the repeat pattern from a date onward', () => {
  const task = fridayTask();
  const { updated, created } = editTask(
    task,
    'following',
    '2026-10-23',
    { recurrence: { startDate: '2026-10-23', frequency: 'weekly', interval: 2, weekdays: [5] } },
    { newId: 'g2' }
  );
  assert.deepEqual(dates(getOccurrences(constantProvider, updated, '2026-10-01', '2026-12-31')), [
    '2026-10-02', '2026-10-09', '2026-10-16',
  ]);
  assert.deepEqual(dates(getOccurrences(constantProvider, created, '2026-10-01', '2026-12-31')), [
    '2026-10-23', '2026-11-06', '2026-11-20', '2026-12-04', '2026-12-18',
  ]);
});

test('16g. "All" changes the base task, keeps completions and exclusions, and new values beat single edits', () => {
  let task = fridayTask();
  task = setCompletion(task, '2026-10-02', true);
  task = deleteOccurrences(task, 'this', '2026-11-13');
  ({ updated: task } = editTask(task, 'this', '2026-10-09', { start: fixed('08:00'), notes: 'special' }));

  const { updated } = editTask(task, 'all', '2026-10-02', { start: fixed('18:30'), durationMinutes: 45 });

  const occ = getOccurrences(constantProvider, updated, '2026-10-01', '2026-11-30');
  assert.ok(occ.every((o) => timeOf(o) === '6:30 PM'), 'the new start time wins everywhere');
  assert.ok(occ.every((o) => o.durationMinutes === 45));
  assert.equal(occ.find((o) => o.dateKey === '2026-10-02').done, true, 'completion kept');
  assert.ok(!dates(occ).includes('2026-11-13'), 'exclusion kept');
  assert.equal(occ.find((o) => o.dateKey === '2026-10-09').notes, 'special', 'unrelated single edit kept');
});

test('16h. Editing a one-off task just edits it', () => {
  const task = createTask({ id: 'o', title: 'Dentist', start: fixed('10:00'), durationMinutes: 60, date: '2026-10-10' });
  const { updated, created } = editTask(task, 'all', '2026-10-10', { title: 'Dentist (moved)', date: '2026-10-12' });
  assert.equal(created, null);
  assert.equal(updated.title, 'Dentist (moved)');
  assert.equal(updated.date, '2026-10-12');
});

test('16i. Edits are validated', () => {
  const task = fridayTask();
  assert.throws(() => editTask(task, 'all', '2026-10-02', { durationMinutes: -5 }));
  assert.throws(() => editTask(task, 'this', '2026-10-09', { title: '' }));
  assert.throws(() => editTask(task, 'sideways', '2026-10-09', { title: 'x' }));
});

test('16j. Delete scopes', () => {
  const task = fridayTask();
  assert.equal(deleteOccurrences(task, 'all', '2026-10-09'), null);
  assert.equal(deleteOccurrences(task, 'following', '2026-10-02'), null, 'deleting from the first occurrence removes the task');

  const trimmed = deleteOccurrences(setCompletion(task, '2026-10-30', true), 'following', '2026-10-23');
  assert.deepEqual(dates(getOccurrences(constantProvider, trimmed, '2026-10-01', '2026-12-31')), [
    '2026-10-02', '2026-10-09', '2026-10-16',
  ]);
  assert.deepEqual(trimmed.completions, {}, 'data from deleted occurrences is dropped');

  const oneOff = createTask({ id: 'o', title: 'Once', start: fixed('10:00'), durationMinutes: 30, date: '2026-10-10' });
  assert.equal(deleteOccurrences(oneOff, 'this', '2026-10-10'), null);
});

// ---- Scenario 17: per-occurrence completion ----------------------------------------------------------------------------
test('17. Marking one occurrence done does not affect other days', () => {
  let task = fridayTask();
  task = setCompletion(task, '2026-10-09', true);
  const occ = getOccurrences(constantProvider, task, '2026-10-02', '2026-10-23');
  assert.deepEqual(occ.map((o) => o.done), [false, true, false, false]);

  task = setCompletion(task, '2026-10-09', false);
  assert.ok(getOccurrences(constantProvider, task, '2026-10-02', '2026-10-23').every((o) => !o.done));
});

// ---- Scenario 28: Date field versus Planning Day -----------------------------------------------------------------------------
test('28. A 2:00 AM one-off task on Oct 5 is shown under the Planning Day Oct 4 -> Oct 5, Zone 5', () => {
  const task = createTask({ id: 'night', title: 'Night study', start: fixed('02:00'), durationMinutes: 60, date: '2026-10-05' });
  assert.equal(task.date, '2026-10-05', 'saved with the calendar date entered');

  const day4 = occurrencesForPlanningDay(provider, [task], '2026-10-04');
  assert.equal(day4.length, 1);
  assert.equal(day4[0].dateKey, '2026-10-05');
  assert.equal(computeDayLayout(provider, '2026-10-04', day4).zones[4].tasks.length, 1);

  const day5 = occurrencesForPlanningDay(provider, [task], '2026-10-05');
  assert.equal(day5.length, 0, 'absent from the Oct 5 -> Oct 6 view');

  const note = placementNote(provider, day4[0].start, '2026-10-05');
  assert.equal(note.differsFromDate, true);
  assert.equal(note.zoneIndex, 5);
  assert.equal(note.text, 'Will appear under Planning Day: Oct 4 → Oct 5, Zone: Isha → Fajr');
});

test('28b. A normal daytime task: the note does not differ from the date entered', () => {
  const start = at('2026-10-05', '09:00');
  const note = placementNote(provider, start, '2026-10-05');
  assert.equal(note.differsFromDate, false);
  assert.equal(note.text, 'Will appear under Planning Day: Oct 5 → Oct 6, Zone: Fajr → Dhuhr');
});

test('28c. A daily recurring 2:00 AM task behaves the same way for every occurrence', () => {
  const task = createTask({
    id: 'daily2am',
    title: 'Early dhikr',
    start: fixed('02:00'),
    durationMinutes: 30,
    recurrence: { startDate: '2026-10-03', frequency: 'daily', interval: 1 },
  });
  // Planning Day Oct 4 contains the occurrence whose calendar date is Oct 5
  const day4 = occurrencesForPlanningDay(provider, [task], '2026-10-04');
  assert.deepEqual(dates(day4), ['2026-10-05']);
  // Planning Day Oct 5 contains the one dated Oct 6
  const day5 = occurrencesForPlanningDay(provider, [task], '2026-10-05');
  assert.deepEqual(dates(day5), ['2026-10-06']);
});

test('28d. A prayer-relative task after midnight ("5 hours after Isha") stays in Zone 5 of that Planning Day', () => {
  const task = createTask({
    id: 'late',
    title: 'Late reading',
    start: { mode: 'prayer', prayer: 'isha', direction: 'after', minutes: 300 },
    durationMinutes: 30,
    date: '2026-10-04',
  });
  const day4 = occurrencesForPlanningDay(provider, [task], '2026-10-04');
  assert.equal(day4.length, 1);
  assert.equal(timeOf(day4[0]), '12:20 AM');
  assert.equal(computeDayLayout(provider, '2026-10-04', day4).zones[4].tasks.length, 1);
});

test('A task running past Fajr shows as continuing in Zone 1 of the next Planning Day', () => {
  const task = createTask({ id: 'n', title: 'Night work', start: fixed('04:30'), durationMinutes: 60, date: '2026-10-05' });
  const day5 = occurrencesForPlanningDay(provider, [task], '2026-10-05');
  assert.equal(day5.length, 1, 'it still touches the Oct 5 Planning Day');
  const zone1 = computeDayLayout(provider, '2026-10-05', day5).zones[0];
  assert.equal(zone1.tasks.length, 0);
  assert.equal(zone1.continued.length, 1);
  assert.equal(zone1.scheduledMinutes, 24);
});

test('Daily View data: several tasks, sorted by start time within each zone', () => {
  const tasks = [
    createTask({ id: '1', title: 'B', start: fixed('10:00'), durationMinutes: 30, date: '2026-10-04' }),
    createTask({ id: '2', title: 'A', start: fixed('07:00'), durationMinutes: 30, date: '2026-10-04' }),
    createTask({ id: '3', title: 'Z5 late', start: fixed('23:30'), durationMinutes: 30, date: '2026-10-04' }),
    createTask({ id: '4', title: 'Z5 after midnight', start: fixed('01:00'), durationMinutes: 30, date: '2026-10-05' }),
    createTask({ id: '5', title: 'Z5 evening', start: fixed('21:00'), durationMinutes: 30, date: '2026-10-04' }),
  ];
  const layout = computeDayLayout(provider, '2026-10-04', occurrencesForPlanningDay(provider, tasks, '2026-10-04'));
  assert.deepEqual(layout.zones[0].tasks.map((t) => t.title), ['A', 'B']);
  assert.deepEqual(
    layout.zones[4].tasks.map((t) => t.title),
    ['Z5 evening', 'Z5 late', 'Z5 after midnight'],
    'after-midnight tasks sort after tasks before midnight'
  );
});
