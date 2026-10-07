'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createTask, validateStart, getOccurrences, occurrencesForPlanningDay, computeDayLayout, editTask,
  deleteOccurrences, setCompletion, remindersInWindow, formatTime12, dependencyProblem, findDependents,
  referencedTaskIds, normalizeData, buildExport, parseImport,
} = require('../src/core');
const { PlannerService } = require('../src/main/service');
const { MemoryStore } = require('../src/main/store');
const { at, constantProvider } = require('./helpers');

const DAY = '2026-10-04';
const fixed = (time) => ({ mode: 'fixed', time });
const follow = (taskId, extra = {}) => ({
  mode: 'task', taskId, point: 'end', direction: 'after', minutes: 0, fallbackTime: '09:00', ...extra,
});

function task(id, start, extra = {}) {
  return createTask({ id, title: id, start, durationMinutes: 30, date: DAY, ...extra });
}

// All occurrences of all tasks for one planning day, as { title: 'h:mm AM' }
function startsOn(tasks, key = DAY) {
  const occ = occurrencesForPlanningDay(constantProvider, tasks, key, { workingDays: [0, 1, 2, 3, 4] });
  return Object.fromEntries(occ.map((o) => [o.taskId, formatTime12(o.start)]));
}

// ---- Validation -------------------------------------------------------------------------------------------------
test('Start definition: checked for every part', () => {
  assert.deepEqual(validateStart(follow('a', { minutes: 15 })), []);
  assert.ok(validateStart(follow('')).some((e) => /Choose the task/.test(e)));
  assert.ok(validateStart(follow('a', { point: 'middle' })).length > 0);
  assert.ok(validateStart(follow('a', { direction: 'around' })).length > 0);
  assert.ok(validateStart(follow('a', { minutes: -1 })).length > 0);
  assert.ok(validateStart(follow('a', { minutes: 2.5 })).length > 0);
  assert.ok(validateStart(follow('a', { fallbackTime: '25:00' })).some((e) => /backup/.test(e)));
  assert.throws(() => task('x', follow('a', { fallbackTime: undefined })), /backup/);
});

// ---- Resolving the start ----------------------------------------------------------------------------------------------
test('After the END of another task, with minutes', () => {
  const a = task('A', fixed('08:00'), { durationMinutes: 90 }); // 8:00-9:30
  const b = task('B', follow('A', { minutes: 15 }));
  assert.deepEqual(startsOn([a, b]), { A: '8:00 AM', B: '9:45 AM' });
  const c = task('C', follow('A', { minutes: 0 }));
  assert.equal(startsOn([a, c]).C, '9:30 AM');
});

test('All four combinations: start/end, before/after', () => {
  const a = task('A', fixed('10:00'), { durationMinutes: 60 }); // 10:00-11:00
  const times = (point, direction) => startsOn([a, task('B', follow('A', { point, direction, minutes: 20 }))]).B;
  assert.equal(times('end', 'after'), '11:20 AM');
  assert.equal(times('end', 'before'), '10:40 AM');
  assert.equal(times('start', 'after'), '10:20 AM');
  assert.equal(times('start', 'before'), '9:40 AM');
});

test('A chain A -> B -> C moves as a whole when the first task changes', () => {
  let a = task('A', fixed('08:00'), { durationMinutes: 60 });
  const b = task('B', follow('A', { minutes: 10 }), { durationMinutes: 45 });
  const c = task('C', follow('B', { minutes: 5 }), { durationMinutes: 30 });
  assert.deepEqual(startsOn([a, b, c]), { A: '8:00 AM', B: '9:10 AM', C: '10:00 AM' });

  ({ updated: a } = editTask(a, 'all', DAY, { start: fixed('09:30') }));
  assert.deepEqual(startsOn([a, b, c]), { A: '9:30 AM', B: '10:40 AM', C: '11:30 AM' });

  ({ updated: a } = editTask(a, 'all', DAY, { durationMinutes: 120 }));
  assert.deepEqual(startsOn([a, b, c]), { A: '9:30 AM', B: '11:40 AM', C: '12:30 PM' });
});

test('Following a prayer-relative task works, and moves with the prayer time', () => {
  const a = task('A', { mode: 'prayer', prayer: 'asr', direction: 'after', minutes: 10 }, { durationMinutes: 20 });
  const b = task('B', follow('A', { minutes: 5 }));
  assert.deepEqual(startsOn([a, b]), { A: '3:24 PM', B: '3:49 PM' });
});

test('Zone, end time and overlap handling use the resolved start', () => {
  const a = task('A', fixed('11:30'), { durationMinutes: 30 }); // ends 12:00, after Dhuhr (11:48)
  const b = task('B', follow('A', { minutes: 0 }));
  const occ = occurrencesForPlanningDay(constantProvider, [a, b], DAY, { workingDays: [0] });
  const layout = computeDayLayout(constantProvider, DAY, occ);
  assert.deepEqual(layout.zones[0].tasks.map((t) => t.title), ['A'], 'A starts in Zone 1');
  assert.deepEqual(layout.zones[1].tasks.map((t) => t.title), ['B'], 'B starts in Zone 2');
});

test('Crossing midnight: a task after 11:30 PM +90 min lands at 1:10 AM, still in that day\'s Zone 5', () => {
  const a = task('A', fixed('23:30'), { durationMinutes: 90 }); // ends 1:00 AM
  const b = task('B', follow('A', { minutes: 10 }));
  const occ = occurrencesForPlanningDay(constantProvider, [a, b], DAY, { workingDays: [0] });
  const bOcc = occ.find((o) => o.taskId === 'B');
  assert.equal(formatTime12(bOcc.start), '1:10 AM');
  assert.equal(bOcc.start.getDate(), 5);
  assert.equal(bOcc.dateKey, DAY, 'it keeps the date of the task it follows');
  const layout = computeDayLayout(constantProvider, DAY, occ);
  assert.deepEqual(layout.zones[4].tasks.map((t) => t.title), ['A', 'B']);
});

// ---- Repeating tasks ----------------------------------------------------------------------------------------------------
function dailyPair() {
  const a = task('A', fixed('08:00'), {
    durationMinutes: 60,
    date: undefined,
    recurrence: { startDate: '2026-10-01', frequency: 'daily', interval: 1 },
  });
  const b = task('B', follow('A', { minutes: 15, fallbackTime: '12:00' }), {
    date: undefined,
    recurrence: { startDate: '2026-10-01', frequency: 'daily', interval: 1 },
  });
  return [a, b];
}

test('A repeating task follows the same day\'s occurrence', () => {
  const [a, b] = dailyPair();
  for (const key of ['2026-10-04', '2026-10-05', '2026-10-06']) {
    assert.equal(startsOn([a, b], key).B, '9:15 AM', key);
  }
});

test('A single-occurrence edit of the first task moves that day\'s follower only', () => {
  let [a, b] = dailyPair();
  ({ updated: a } = editTask(a, 'this', '2026-10-05', { start: fixed('10:00') }));
  assert.equal(startsOn([a, b], '2026-10-04').B, '9:15 AM');
  assert.equal(startsOn([a, b], '2026-10-05').B, '11:15 AM');
  assert.equal(startsOn([a, b], '2026-10-06').B, '9:15 AM');
});

test('When the other task has no occurrence on a day: backup time, with a warning, on that day only', () => {
  let [a, b] = dailyPair();
  a = deleteOccurrences(a, 'this', '2026-10-05');
  const occ = (key) => getOccurrences(constantProvider, b, key, key, { tasks: [a, b] })[0];
  assert.equal(formatTime12(occ('2026-10-04').start), '9:15 AM');
  assert.equal(occ('2026-10-04').startWarning, null);
  assert.equal(formatTime12(occ('2026-10-05').start), '12:00 PM');
  assert.match(occ('2026-10-05').startWarning, /not on this day/);
  assert.equal(formatTime12(occ('2026-10-06').start), '9:15 AM');
});

test('A one-off task on a day when the other task is not there uses its backup time', () => {
  const a = task('A', fixed('08:00'), { date: '2026-10-09' });
  const b = task('B', follow('A', { fallbackTime: '14:30' }), { date: DAY });
  const [o] = getOccurrences(constantProvider, b, DAY, DAY, { tasks: [a, b] });
  assert.equal(formatTime12(o.start), '2:30 PM');
  assert.ok(o.startWarning);
});

test('A task whose reference is missing from the list uses the backup time with a warning', () => {
  const b = task('B', follow('gone', { fallbackTime: '07:15' }));
  const [o] = getOccurrences(constantProvider, b, DAY, DAY, { tasks: [b] });
  assert.equal(formatTime12(o.start), '7:15 AM');
  assert.ok(o.startWarning);
});

test('"This and following" on the first task: followers keep following the later part', () => {
  let [a, b] = dailyPair();
  const result = editTask(a, 'following', '2026-10-10', { start: fixed('09:00') }, { newId: 'A2' });
  a = result.updated;
  const a2 = result.created;
  assert.equal(a2.continuedFrom, 'A');
  const all = [a, a2, b];
  assert.equal(startsOn(all, '2026-10-09').B, '9:15 AM', 'before the change');
  assert.equal(startsOn(all, '2026-10-10').B, '10:15 AM', 'after the change, B follows the new part');
  assert.equal(startsOn(all, '2026-10-20').B, '10:15 AM');
});

test('Marking a task done does not move the tasks that follow it', () => {
  const a = setCompletion(task('A', fixed('08:00'), { durationMinutes: 60 }), DAY, true);
  const b = task('B', follow('A', { minutes: 10 }));
  assert.equal(startsOn([a, b]).B, '9:10 AM');
});

// ---- Loops and checks --------------------------------------------------------------------------------------------------------
test('Dependency checks: itself, missing, circle', () => {
  const a = task('A', fixed('08:00'));
  const b = task('B', follow('A'));
  assert.equal(dependencyProblem([a, b], b), null);
  assert.match(dependencyProblem([a], task('S', follow('S'))), /itself/);
  assert.match(dependencyProblem([a], task('M', follow('nope'))), /no longer exists/);

  // A would follow B, while B already follows A
  const aLoop = { ...a, start: follow('B') };
  assert.match(dependencyProblem([a, b], aLoop), /circle/);

  // Three tasks in a circle
  const c = task('C', follow('B'));
  assert.match(dependencyProblem([a, b, c], { ...a, start: follow('C') }), /circle/);
});

test('A loop that slipped in is survived: a backup time is used, every task in the loop shows a warning, nothing crashes', () => {
  const a = task('A', follow('B', { fallbackTime: '06:00' }));
  const b = task('B', follow('A', { fallbackTime: '07:00' }));
  for (const t of [a, b]) {
    const occ = getOccurrences(constantProvider, t, DAY, DAY, { tasks: [a, b] });
    assert.equal(occ.length, 1);
    assert.match(occ[0].startWarning, /depend on each other/);
  }
});

test('A task further down a chain says when it rests on a backup time', () => {
  const a = task('A', fixed('08:00'), { date: '2026-10-09' }); // not on DAY
  const b = task('B', follow('A', { fallbackTime: '12:00' }));
  const c = task('C', follow('B', { minutes: 10 }));
  const [bOcc] = getOccurrences(constantProvider, b, DAY, DAY, { tasks: [a, b, c] });
  const [cOcc] = getOccurrences(constantProvider, c, DAY, DAY, { tasks: [a, b, c] });
  assert.match(bOcc.startWarning, /not on this day/);
  assert.equal(formatTime12(cOcc.start), '12:40 PM');
  assert.match(cOcc.startWarning, /earlier in this chain/);
});

test('Dependents are found, including single-occurrence references', () => {
  const a = task('A', fixed('08:00'));
  const b = task('B', follow('A'));
  let c = task('C', fixed('10:00'), { date: undefined, recurrence: { startDate: DAY, frequency: 'daily', interval: 1 } });
  ({ updated: c } = editTask(c, 'this', '2026-10-06', { start: follow('A') }));
  assert.deepEqual(findDependents([a, b, c], 'A').map((t) => t.id), ['B', 'C']);
  assert.deepEqual(Array.from(referencedTaskIds(c)), ['A']);
  assert.deepEqual(findDependents([a, b, c], 'B'), []);
});

// ---- Reminders ------------------------------------------------------------------------------------------------------------------
test('Reminders for a following task use its resolved start and move with it', () => {
  let a = task('A', fixed('08:00'), { durationMinutes: 60 });
  const b = task('B', follow('A', { minutes: 15 }), { reminders: { enabled: true, offsets: [10, 0] } });
  const window = [at(DAY, '00:00').getTime(), at(DAY, '23:59').getTime()];
  const times = (list) => remindersInWindow(constantProvider, list, ...window, {}).filter((r) => r.taskId === 'B').map((r) => formatTime12(r.notifyAt));
  assert.deepEqual(times([a, b]), ['9:05 AM', '9:15 AM']);
  ({ updated: a } = editTask(a, 'all', DAY, { start: fixed('09:00') }));
  assert.deepEqual(times([a, b]), ['10:05 AM', '10:15 AM']);
});

// ---- Saved data ---------------------------------------------------------------------------------------------------------------------
test('Saved and exported data keep the new start mode and the split link', () => {
  const a = task('A', fixed('08:00'), { date: undefined, recurrence: { startDate: DAY, frequency: 'daily', interval: 1 } });
  const { updated, created } = editTask(a, 'following', '2026-10-10', { title: 'A later' }, { newId: 'A2' });
  const b = task('B', follow('A', { minutes: 5 }));
  const { data, warnings } = normalizeData({ tasks: [updated, created, b] });
  assert.deepEqual(warnings, []);
  assert.equal(data.tasks.find((t) => t.id === 'A2').continuedFrom, 'A');
  assert.deepEqual(data.tasks.find((t) => t.id === 'B').start, follow('A', { minutes: 5 }));

  const exported = JSON.parse(JSON.stringify(buildExport({ ...data })));
  const again = parseImport(exported);
  assert.equal(again.data.tasks.length, 3);
});

// ---- Through the planner service ---------------------------------------------------------------------------------------------------
function makeService() {
  let n = 0;
  return new PlannerService({
    store: new MemoryStore(),
    now: () => at(DAY, '07:00'),
    newId: () => `id${++n}`,
    providerFactory: () => constantProvider,
  });
}

function form(extra = {}) {
  return {
    title: 'T', start: fixed('08:00'), durationMinutes: 60, date: DAY, recurrence: null,
    reminders: { enabled: false, offsets: [] }, priority: 'Medium', categoryId: null, notes: '', ...extra,
  };
}

test('Service: create a chain, see it in the day, with "follows" and warnings', () => {
  const svc = makeService();
  const a = svc.saveTask({ mode: 'create', form: form({ title: 'Study SQL', durationMinutes: 90 }) }).taskId;
  svc.saveTask({ mode: 'create', form: form({ title: 'Exercise', start: follow(a, { minutes: 15 }) }) });
  const rows = svc.getDay(DAY).zones[0].tasks;
  assert.deepEqual(rows.map((r) => [r.title, r.startLabel]), [['Study SQL', '8:00 AM'], ['Exercise', '9:45 AM']]);
  assert.equal(rows[1].followsTitle, 'Study SQL');
  assert.equal(rows[1].startWarning, null);
  assert.equal(rows[0].followsTitle, null);

  // Move the first one: the second follows
  const edit = svc.getTaskForEdit({ taskId: a, dateKey: DAY });
  svc.saveTask({ mode: 'edit', taskId: a, dateKey: DAY, scope: 'all', form: { ...edit.form, start: fixed('10:00') } });
  assert.deepEqual(svc.getDay(DAY).zones[0].tasks.map((r) => r.startLabel), ['10:00 AM', '11:45 AM']);
});

test('Service: previews show the resolved time, the backup-time warning and loop errors', () => {
  const svc = makeService();
  const a = svc.saveTask({ mode: 'create', form: form({ title: 'A', durationMinutes: 90 }) }).taskId;

  const ok = svc.previewForm(form({ start: follow(a, { minutes: 15 }) }), {});
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.resolved.startLabel, '9:45 AM');
  assert.equal(ok.resolved.endLabel, '10:45 AM');
  assert.equal(ok.resolved.warning, null);
  assert.equal(ok.placement.zoneName, 'Fajr → Dhuhr');

  const otherDay = svc.previewForm(form({ start: follow(a, { fallbackTime: '14:00' }), date: '2026-10-09' }), {});
  assert.equal(otherDay.resolved.startLabel, '2:00 PM');
  assert.match(otherDay.resolved.warning, /not on this day/);

  assert.ok(svc.previewForm(form({ start: follow('') }), {}).errors.some((e) => /Choose the task/.test(e)));
  assert.ok(svc.previewForm(form({ start: follow(a) }), { taskId: a }).errors.some((e) => /itself/.test(e)));
});

test('Service: refuses loops and missing tasks when saving', () => {
  const svc = makeService();
  const a = svc.saveTask({ mode: 'create', form: form({ title: 'A' }) }).taskId;
  const b = svc.saveTask({ mode: 'create', form: form({ title: 'B', start: follow(a) }) }).taskId;
  const editA = svc.getTaskForEdit({ taskId: a, dateKey: DAY });
  assert.throws(
    () => svc.saveTask({ mode: 'edit', taskId: a, dateKey: DAY, scope: 'all', form: { ...editA.form, start: follow(b) } }),
    /circle/
  );
  assert.throws(() => svc.saveTask({ mode: 'create', form: form({ start: follow('ghost') }) }), /no longer exists/);
  assert.equal(svc.data.tasks.find((t) => t.id === a).start.mode, 'fixed', 'nothing was changed');
});

test('Service: the list of tasks to follow leaves out the task itself and the tasks that follow it', () => {
  const svc = makeService();
  const a = svc.saveTask({ mode: 'create', form: form({ title: 'A' }) }).taskId;
  const b = svc.saveTask({ mode: 'create', form: form({ title: 'B', start: follow(a) }) }).taskId;
  const c = svc.saveTask({ mode: 'create', form: form({ title: 'C', start: follow(b) }) }).taskId;
  const d = svc.saveTask({ mode: 'create', form: form({ title: 'D' }) }).taskId;

  assert.deepEqual(svc.getReferenceChoices({ taskId: null }).map((x) => x.title), ['A', 'B', 'C', 'D']);
  assert.deepEqual(svc.getReferenceChoices({ taskId: a }).map((x) => x.title), ['D']);
  assert.deepEqual(svc.getReferenceChoices({ taskId: b }).map((x) => x.title), ['A', 'D']);
  assert.ok(svc.getReferenceChoices({ taskId: d }).length === 3);
  const first = svc.getReferenceChoices({ taskId: null })[0];
  assert.equal(first.label, 'A (8:00 AM, 1h 0m)');
  void c;
});

test('Service: deleting a task others follow warns, then keeps the followers at their times', () => {
  const svc = makeService();
  const a = svc.saveTask({ mode: 'create', form: form({ title: 'A', durationMinutes: 90 }) }).taskId;
  const b = svc.saveTask({ mode: 'create', form: form({ title: 'B', start: follow(a, { minutes: 15 }) }) }).taskId;
  const c = svc.saveTask({ mode: 'create', form: form({ title: 'C', start: follow(b, { minutes: 5 }) }) }).taskId;

  const impact = svc.getDeleteImpact({ taskId: a, dateKey: DAY, scope: 'all' });
  assert.equal(impact.wholeTask, true);
  assert.deepEqual(impact.dependents, [{ taskId: b, title: 'B' }]);

  const result = svc.deleteTask({ taskId: a, dateKey: DAY, scope: 'all' });
  assert.deepEqual(result.frozen, [{ taskId: b, title: 'B', exact: true }]);
  assert.deepEqual(svc.getDay(DAY).zones[0].tasks.map((r) => [r.title, r.startLabel, r.startWarning]), [
    ['B', '9:45 AM', null],
    ['C', '10:50 AM', null],
  ]);
  assert.deepEqual(svc.data.tasks.find((t) => t.id === b).start, fixed('09:45'));
  assert.equal(svc.data.tasks.find((t) => t.id === c).start.mode, 'task', 'C still follows B');
});

test('Service: deleting just one day of a repeating task does not freeze followers; they use the backup time that day', () => {
  const svc = makeService();
  const repeating = { startDate: '2026-10-01', frequency: 'daily', interval: 1 };
  const a = svc.saveTask({ mode: 'create', form: form({ title: 'A', recurrence: repeating }) }).taskId;
  svc.saveTask({ mode: 'create', form: form({ title: 'B', recurrence: repeating, start: follow(a, { minutes: 10, fallbackTime: '13:00' }) }) });

  const impact = svc.getDeleteImpact({ taskId: a, dateKey: '2026-10-05', scope: 'this' });
  assert.equal(impact.wholeTask, false);
  svc.deleteTask({ taskId: a, dateKey: '2026-10-05', scope: 'this' });

  const row = (key) => svc.getDay(key).zones.flatMap((z) => z.tasks).find((t) => t.title === 'B');
  assert.equal(row('2026-10-04').startLabel, '9:10 AM');
  assert.equal(row('2026-10-05').startLabel, '1:00 PM');
  assert.ok(row('2026-10-05').startWarning);
  assert.equal(row('2026-10-06').startLabel, '9:10 AM');
});

test('Service: a follower that crosses midnight cannot keep its exact time and is reported', () => {
  const svc = makeService();
  const a = svc.saveTask({ mode: 'create', form: form({ title: 'A', start: fixed('23:30'), durationMinutes: 90 }) }).taskId;
  const b = svc.saveTask({ mode: 'create', form: form({ title: 'B', start: follow(a, { minutes: 10, fallbackTime: '08:00' }) }) }).taskId;
  const result = svc.deleteTask({ taskId: a, dateKey: DAY, scope: 'all' });
  assert.deepEqual(result.frozen, [{ taskId: b, title: 'B', exact: false }]);
  assert.deepEqual(svc.data.tasks.find((t) => t.id === b).start, fixed('08:00'));
});

test('Service: editing the earlier part of a repeating task keeps followers attached', () => {
  const svc = makeService();
  const repeating = { startDate: '2026-10-01', frequency: 'daily', interval: 1 };
  const a = svc.saveTask({ mode: 'create', form: form({ title: 'A', recurrence: repeating }) }).taskId;
  svc.saveTask({ mode: 'create', form: form({ title: 'B', recurrence: repeating, start: follow(a, { minutes: 10 }) }) });

  const edit = svc.getTaskForEdit({ taskId: a, dateKey: '2026-10-10' });
  svc.saveTask({ mode: 'edit', taskId: a, dateKey: '2026-10-10', scope: 'following', form: { ...edit.form, start: fixed('09:00') } });

  const row = (key) => svc.getDay(key).zones.flatMap((z) => z.tasks).find((t) => t.title === 'B');
  assert.equal(row('2026-10-09').startLabel, '9:10 AM');
  assert.equal(row('2026-10-10').startLabel, '10:10 AM');
  assert.equal(row('2026-10-10').startWarning, null);
});

test('Service: a single occurrence can be switched to follow another task', () => {
  const svc = makeService();
  const repeating = { startDate: '2026-10-01', frequency: 'daily', interval: 1 };
  const a = svc.saveTask({ mode: 'create', form: form({ title: 'A', recurrence: repeating }) }).taskId;
  const x = svc.saveTask({ mode: 'create', form: form({ title: 'X', start: fixed('14:00'), recurrence: repeating }) }).taskId;
  const edit = svc.getTaskForEdit({ taskId: x, dateKey: '2026-10-06' });
  svc.saveTask({ mode: 'edit', taskId: x, dateKey: '2026-10-06', scope: 'this', form: { ...edit.form, start: follow(a, { minutes: 30 }) } });

  const row = (key) => svc.getDay(key).zones.flatMap((z) => z.tasks).find((t) => t.title === 'X');
  assert.equal(row('2026-10-05').startLabel, '2:00 PM');
  assert.equal(row('2026-10-06').startLabel, '9:30 AM');
  assert.equal(row('2026-10-06').followsTitle, 'A');
  assert.equal(svc.getDeleteImpact({ taskId: a, dateKey: DAY, scope: 'all' }).dependents.length, 1);
});
