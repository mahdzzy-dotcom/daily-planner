'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createTask,
  setCompletion,
  editTask,
  deleteOccurrences,
  reminderOffsets,
  remindersInWindow,
  zoneStartEvents,
  formatTaskNotification,
  formatZoneNotification,
  summarizeMissed,
  formatMissedNotification,
  formatTime12,
  DEFAULT_REMINDER_SETTINGS,
} = require('../src/core');
const { at, provider, constantProvider } = require('./helpers');

const fixed = (time) => ({ mode: 'fixed', time });
const reminders = (offsets, enabled = true) => ({ enabled, offsets });

function ms(date) {
  return date.getTime();
}

function times(list) {
  return list.map((r) => formatTime12(r.notifyAt));
}

function oneOff(id, time, offsets, date = '2026-10-04', extra = {}) {
  return createTask({
    id,
    title: id,
    start: fixed(time),
    durationMinutes: 30,
    date,
    reminders: reminders(offsets),
    ...extra,
  });
}

// ---- Offsets ------------------------------------------------------------------------------------
test('Reminder off gives no reminders; on with an empty list uses the default offset', () => {
  assert.deepEqual(reminderOffsets(reminders([15, 0], false), {}), []);
  assert.deepEqual(reminderOffsets(null, {}), []);
  assert.deepEqual(reminderOffsets(reminders([]), {}), [10]);
  assert.deepEqual(reminderOffsets(reminders([]), { defaultReminderOffsetMinutes: 20 }), [20]);
});

test('Identical offsets count once and the earliest notification comes first', () => {
  assert.deepEqual(reminderOffsets(reminders([0, 15, 15, 5, 0]), {}), [15, 5, 0]);
});

// ---- Scenario 18 ---------------------------------------------------------------------------------
test('18. A 9:00 AM task with reminders {15, 0} notifies at 8:45 AM and 9:00 AM', () => {
  const task = oneOff('meet', '09:00', [15, 0]);
  const list = remindersInWindow(provider, [task], ms(at('2026-10-04', '00:00')), ms(at('2026-10-04', '23:59')), {});
  assert.deepEqual(times(list), ['8:45 AM', '9:00 AM']);
  assert.deepEqual(list.map((r) => r.offsetMinutes), [15, 0]);
  assert.ok(list.every((r) => r.title === 'meet' && r.zoneName === 'Fajr → Dhuhr'));
});

test('18b. The same offsets apply to every occurrence of a daily recurrence', () => {
  const task = createTask({
    id: 'daily',
    title: 'Daily',
    start: fixed('09:00'),
    durationMinutes: 30,
    recurrence: { startDate: '2026-10-04', frequency: 'daily', interval: 1 },
    reminders: reminders([15, 0]),
  });
  const list = remindersInWindow(provider, [task], ms(at('2026-10-04', '00:00')), ms(at('2026-10-06', '23:59')), {});
  assert.deepEqual(times(list), ['8:45 AM', '9:00 AM', '8:45 AM', '9:00 AM', '8:45 AM', '9:00 AM']);
  assert.deepEqual(
    list.map((r) => r.dateKey),
    ['2026-10-04', '2026-10-04', '2026-10-05', '2026-10-05', '2026-10-06', '2026-10-06']
  );
});

test('18c. A prayer-relative task\'s notification moves with the resolved start time', () => {
  const task = createTask({
    id: 'asr',
    title: 'After Asr',
    start: { mode: 'prayer', prayer: 'asr', direction: 'after', minutes: 10 },
    durationMinutes: 20,
    recurrence: { startDate: '2026-10-04', frequency: 'daily', interval: 1 },
    reminders: reminders([0]),
  });
  const list = remindersInWindow(provider, [task], ms(at('2026-10-04', '00:00')), ms(at('2026-10-05', '23:59')), {});
  // Asr is 3:14 PM on Oct 4 and 3:12 PM on Oct 5
  assert.deepEqual(times(list), ['3:24 PM', '3:22 PM']);
});

test('18d. A reminder before a task just after midnight lands on the previous clock day', () => {
  const task = oneOff('night', '00:30', [60], '2026-10-05');
  const list = remindersInWindow(provider, [task], ms(at('2026-10-04', '00:00')), ms(at('2026-10-05', '23:59')), {});
  assert.equal(list.length, 1);
  assert.equal(formatTime12(list[0].notifyAt), '11:30 PM');
  assert.equal(list[0].notifyAt.getDate(), 4);
  assert.equal(list[0].zoneIndex, 5);
});

test('18e. Large offsets (a day before) are found even when the task is far away', () => {
  const task = oneOff('trip', '09:00', [1440], '2026-10-10');
  const list = remindersInWindow(provider, [task], ms(at('2026-10-08', '00:00')), ms(at('2026-10-09', '23:59')), {});
  assert.equal(list.length, 1);
  assert.equal(list[0].notifyAt.getTime(), at('2026-10-09', '09:00').getTime());
});

test('The window is exclusive at the start and inclusive at the end', () => {
  const task = oneOff('edge', '09:00', [0]);
  const nine = ms(at('2026-10-04', '09:00'));
  assert.equal(remindersInWindow(provider, [task], nine - 1000, nine, {}).length, 1);
  assert.equal(remindersInWindow(provider, [task], nine, nine + 1000, {}).length, 0);
});

test('Completed occurrences and tasks with reminders off get no reminders', () => {
  let task = oneOff('done', '09:00', [15, 0]);
  const from = ms(at('2026-10-04', '00:00'));
  const to = ms(at('2026-10-04', '23:59'));
  assert.equal(remindersInWindow(provider, [task], from, to, {}).length, 2);
  task = setCompletion(task, '2026-10-04', true);
  assert.equal(remindersInWindow(provider, [task], from, to, {}).length, 0);

  const off = createTask({ id: 'off', title: 'off', start: fixed('09:00'), durationMinutes: 30, date: '2026-10-04' });
  assert.equal(remindersInWindow(provider, [off], from, to, {}).length, 0);
});

test('Excluded occurrences and single-occurrence edits are respected', () => {
  let task = createTask({
    id: 'fri',
    title: 'Fri',
    start: fixed('09:00'),
    durationMinutes: 30,
    recurrence: { startDate: '2026-10-02', frequency: 'weekly', interval: 1, weekdays: [5] },
    reminders: reminders([0]),
  });
  task = deleteOccurrences(task, 'this', '2026-10-09');
  ({ updated: task } = editTask(task, 'this', '2026-10-16', { start: fixed('07:30') }));
  const list = remindersInWindow(constantProvider, [task], ms(at('2026-10-01', '00:00')), ms(at('2026-10-24', '00:00')), {});
  assert.deepEqual(
    list.map((r) => `${r.dateKey} ${formatTime12(r.notifyAt)}`),
    ['2026-10-02 9:00 AM', '2026-10-16 7:30 AM', '2026-10-23 9:00 AM']
  );
});

test('A reminder list set on one occurrence only applies to that occurrence', () => {
  let task = createTask({
    id: 'sp',
    title: 'Special',
    start: fixed('09:00'),
    durationMinutes: 30,
    recurrence: { startDate: '2026-10-04', frequency: 'daily', interval: 1 },
    reminders: reminders([0]),
  });
  ({ updated: task } = editTask(task, 'this', '2026-10-05', { reminders: reminders([30, 0]) }));
  const list = remindersInWindow(provider, [task], ms(at('2026-10-04', '00:00')), ms(at('2026-10-05', '23:59')), {});
  assert.deepEqual(times(list), ['9:00 AM', '8:30 AM', '9:00 AM']);
});

test('Moving a task creates reminders with new ids', () => {
  const a = oneOff('mv', '09:00', [0]);
  const { updated: b } = editTask(a, 'all', '2026-10-04', { start: fixed('10:00') });
  const range = [ms(at('2026-10-04', '00:00')), ms(at('2026-10-04', '23:59'))];
  const idA = remindersInWindow(provider, [a], ...range, {})[0].id;
  const idB = remindersInWindow(provider, [b], ...range, {})[0].id;
  assert.notEqual(idA, idB);
});

// ---- Zone-start events ------------------------------------------------------------------------------
test('Zone-start events fall at each prayer time', () => {
  const events = zoneStartEvents(provider, ms(at('2026-10-04', '00:00')), ms(at('2026-10-04', '23:59')));
  assert.deepEqual(events.map((e) => formatTime12(e.notifyAt)), ['5:05 AM', '11:48 AM', '3:14 PM', '6:00 PM', '7:20 PM']);
  assert.deepEqual(events.map((e) => e.zoneIndex), [1, 2, 3, 4, 5]);
  assert.equal(formatTime12(events[4].zoneEnd), '5:06 AM', 'Zone 5 ends at the next Fajr');
  assert.equal(formatTime12(events[0].zoneEnd), '11:48 AM');
});

// ---- Notification text ---------------------------------------------------------------------------------
test('Task notification shows title, start time and zone name', () => {
  const task = oneOff('Study', '09:00', [15, 0]);
  const [first, second] = remindersInWindow(provider, [task], ms(at('2026-10-04', '00:00')), ms(at('2026-10-04', '23:59')), {});

  const a = formatTaskNotification(first, first.offsetMinutes, DEFAULT_REMINDER_SETTINGS);
  assert.equal(a.title, 'Study');
  assert.deepEqual(a.lines, ['Starts in 15 min · 9:00 AM', 'Zone: Fajr → Dhuhr']);
  assert.equal(a.silent, false);
  assert.deepEqual(a.actions.map((x) => x.type), ['snooze', 'done']);
  assert.equal(a.actions[0].label, 'Snooze 5 min');
  assert.equal(a.taskId, 'Study');
  assert.equal(a.dateKey, '2026-10-04');

  const b = formatTaskNotification(second, second.offsetMinutes, { soundEnabled: false, snoozeMinutes: 10 });
  assert.equal(b.lines[0], 'Starts now · 9:00 AM');
  assert.equal(b.silent, true);
  assert.equal(b.actions[0].label, 'Snooze 10 min');

  assert.equal(formatTaskNotification(first, 90, {}).lines[0], 'Starts in 1h 30m · 9:00 AM');
  assert.equal(formatTaskNotification(first, -3, {}).lines[0], 'Started at 9:00 AM');
});

test('Arabic task titles reach the notification unchanged', () => {
  const task = oneOff('x', '09:00', [0], '2026-10-04', { title: 'مراجعة الدرس' });
  const [r] = remindersInWindow(provider, [task], ms(at('2026-10-04', '00:00')), ms(at('2026-10-04', '23:59')), {});
  assert.equal(formatTaskNotification(r, 0, {}).title, 'مراجعة الدرس');
});

test('Zone and missed notification text', () => {
  const [event] = zoneStartEvents(provider, ms(at('2026-10-04', '14:00')), ms(at('2026-10-04', '16:00')));
  const z = formatZoneNotification(event, {});
  assert.equal(z.title, 'Asr → Maghrib has started');
  assert.deepEqual(z.lines, ['Until 6:00 PM']);
  assert.deepEqual(z.actions, []);

  const now = at('2026-10-04', '12:00');
  const a = oneOff('A', '09:00', [15, 0]);
  const b = oneOff('B', '10:00', [0]);
  const missed = remindersInWindow(provider, [a, b], ms(at('2026-10-04', '00:00')), ms(now), {});
  const items = summarizeMissed(missed, now);
  assert.equal(items.length, 2, 'one entry per task occurrence');
  assert.equal(items[0].title, 'A');
  assert.equal(formatTime12(items[0].notifyAt), '8:45 AM', 'earliest missed reminder is kept');
  assert.equal(items[0].alreadyStarted, true);

  const m = formatMissedNotification(items, {});
  assert.equal(m.title, 'You missed 2 reminders');
  assert.deepEqual(m.lines, ['9:00 AM · A', '10:00 AM · B']);
  assert.equal(formatMissedNotification(items.slice(0, 1), {}).title, 'You missed 1 reminder');

  const many = Array.from({ length: 5 }, (_, i) => ({ ...items[0], title: `T${i}`, notifyAt: new Date(now.getTime() + i) }));
  const mm = formatMissedNotification(many, {});
  assert.equal(mm.lines.length, 4);
  assert.equal(mm.lines[3], 'and 2 more');
});
