'use strict';

// The full-screen alert at the exact start time: timing, rules and edge cases.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ReminderEngine, emptyState, createTask, setCompletion, alertsInWindow, formatTime12,
} = require('../src/core');
const { at, atS, provider } = require('./helpers');

const DAY = '2026-10-04';
const fixed = (time) => ({ mode: 'fixed', time });

function task(id, time, extra = {}) {
  const { reminders, ...rest } = extra;
  return createTask({
    id, title: id, notes: `Notes of ${id}`, start: fixed(time), durationMinutes: 30, date: DAY,
    reminders: { enabled: false, offsets: [], fullScreen: true, ...(reminders || {}) },
    ...rest,
  });
}

function setup(options = {}) {
  const world = {
    clock: options.startAt || at(DAY, '11:00'),
    tasks: options.tasks || [],
    settings: options.settings || {},
    toasts: [],
    alerts: [], // { at: Date, items }
    timers: [], // { fn, ms, cleared }
    saves: [],
    errors: [],
  };
  world.engine = new ReminderEngine({
    getTasks: () => world.tasks,
    getProvider: () => options.provider || provider,
    getSettings: () => world.settings,
    notify: (payload) => world.toasts.push({ at: world.clock, payload }),
    showAlert: (items) => world.alerts.push({ at: world.clock, items }),
    onMissed: (items) => world.missed = items,
    updateTask: (updated) => { world.tasks = world.tasks.map((t) => (t.id === updated.id ? updated : t)); },
    saveState: (state) => world.saves.push(state),
    onError: (e) => world.errors.push(e),
    now: () => world.clock,
    setTimeout: (fn, ms) => {
      const timer = { ms, cleared: false, fired: false };
      timer.fn = () => { timer.fired = true; fn(); };
      world.timers.push(timer);
      return world.timers.length - 1;
    },
    clearTimeout: (id) => { if (world.timers[id]) world.timers[id].cleared = true; },
    initialState: options.initialState,
  });
  world.tickAt = (date) => { world.clock = date; return world.engine.tick(date); };
  world.live = () => world.timers.filter((t) => !t.cleared && !t.fired);
  return world;
}

const titles = (entry) => entry.items.map((i) => i.title);

// ---- The schedule -----------------------------------------------------------------------------------------
test('alertsInWindow: only tasks with the full-screen switch on, at the start moment, not completed', () => {
  const on = task('on', '12:00');
  const off = task('off', '12:00', { reminders: { fullScreen: false } });
  const done = setCompletion(task('done', '12:00'), DAY, true);
  const from = at(DAY, '11:00').getTime();
  const to = at(DAY, '13:00').getTime();
  const list = alertsInWindow(provider, [on, off, done], from, to, {});
  assert.deepEqual(list.map((a) => a.title), ['on']);
  assert.equal(formatTime12(list[0].start), '12:00 PM');
  assert.equal(list[0].notes, 'Notes of on');
  assert.equal(list[0].zoneName, 'Dhuhr → Asr');

  const noon = at(DAY, '12:00').getTime();
  assert.equal(alertsInWindow(provider, [on], noon - 1000, noon, {}).length, 1, 'inclusive at the end');
  assert.equal(alertsInWindow(provider, [on], noon, noon + 1000, {}).length, 0, 'exclusive at the start');
});

test('A task without the flag (older saved data) gets no alert', () => {
  const plain = createTask({ id: 'p', title: 'p', start: fixed('12:00'), durationMinutes: 30, date: DAY, reminders: { enabled: true, offsets: [0] } });
  assert.equal(alertsInWindow(provider, [plain], at(DAY, '11:00').getTime(), at(DAY, '13:00').getTime(), {}).length, 0);
  assert.throws(() => createTask({ id: 'x', title: 'x', start: fixed('12:00'), durationMinutes: 30, date: DAY, reminders: { enabled: false, offsets: [], fullScreen: 'yes' } }), /full-screen/);
});

// ---- Exact timing ---------------------------------------------------------------------------------------------
test('A timer is set for the exact start moment and the alert appears then, not at the next 15-second check', () => {
  const w = setup({ tasks: [task('Study', '12:00')], startAt: atS(DAY, '11:59:37') });
  w.tickAt(atS(DAY, '11:59:37')); // the first run only anchors the clock
  w.tickAt(atS(DAY, '11:59:45'));
  assert.equal(w.alerts.length, 0);
  const live = w.live();
  assert.equal(live.length, 1, 'exactly one timer is waiting');
  assert.equal(live[0].ms, 15000, '15 seconds from 11:59:45 is 12:00:00');

  w.clock = atS(DAY, '12:00:00');
  live[0].fn(); // the timer goes off
  assert.equal(w.alerts.length, 1);
  assert.deepEqual(titles(w.alerts[0]), ['Study']);
  assert.equal(w.alerts[0].at.getTime(), at(DAY, '12:00').getTime(), 'shown at exactly 12:00:00');
});

test('A timer that goes off a few milliseconds early still shows the alert', () => {
  const w = setup({ tasks: [task('Study', '12:00')], startAt: atS(DAY, '11:59:00') });
  w.tickAt(atS(DAY, '11:59:00'));
  w.tickAt(atS(DAY, '11:59:30'));
  const [timer] = w.live();
  w.clock = new Date(at(DAY, '12:00').getTime() - 3); // 3 ms before the minute
  timer.fn();
  assert.equal(w.alerts.length, 1);
});

test('No repeat: the next regular check does not show it again; a restart does not either', () => {
  const w = setup({ tasks: [task('Study', '12:00')], startAt: atS(DAY, '11:59:30') });
  w.tickAt(atS(DAY, '11:59:30'));
  w.tickAt(atS(DAY, '11:59:45'));
  w.clock = at(DAY, '12:00');
  w.live()[0].fn();
  w.tickAt(atS(DAY, '12:00:15'));
  w.tickAt(atS(DAY, '12:00:30'));
  assert.equal(w.alerts.length, 1);

  const saved = w.saves[w.saves.length - 1];
  const again = setup({
    tasks: w.tasks,
    startAt: atS(DAY, '12:00:20'),
    initialState: { ...saved, lastTickAt: atS(DAY, '11:59:50').getTime() },
  });
  again.tickAt(atS(DAY, '12:00:25'));
  assert.equal(again.alerts.length, 0);
});

test('After an alert the timer moves on to the next one; stopping the engine cancels it', () => {
  const w = setup({ tasks: [task('A', '12:00'), task('B', '12:30')], startAt: atS(DAY, '11:59:30') });
  w.tickAt(atS(DAY, '11:59:30'));
  w.tickAt(atS(DAY, '11:59:45'));
  w.clock = at(DAY, '12:00');
  w.live()[0].fn();
  const next = w.live();
  assert.equal(next.length, 1);
  assert.equal(next[0].ms, 30 * 60000, 'now waiting for 12:30');
  w.engine.stop();
  assert.equal(w.live().length, 0);
});

test('Tasks starting at the same moment are shown together, in order', () => {
  const w = setup({ tasks: [task('Zeta', '12:00'), task('Alpha', '12:00')], startAt: atS(DAY, '11:59:30') });
  w.tickAt(atS(DAY, '11:59:30'));
  w.tickAt(atS(DAY, '11:59:45'));
  w.clock = at(DAY, '12:00');
  w.live()[0].fn();
  assert.equal(w.alerts.length, 1, 'one alert screen');
  assert.deepEqual(titles(w.alerts[0]).sort(), ['Alpha', 'Zeta']);
});

test('Changing a task moves the alert: reschedule() sets a new timer and cancels the old one', () => {
  const w = setup({ tasks: [task('A', '12:00')], startAt: atS(DAY, '11:00:00') });
  w.tickAt(atS(DAY, '11:00:00'));
  w.tickAt(atS(DAY, '11:00:15'));
  const first = w.live()[0];
  assert.equal(first.ms, 3585000);

  w.tasks = [task('A', '12:30')];
  w.engine.reschedule();
  assert.equal(first.cleared, true);
  assert.equal(w.live()[0].ms, at(DAY, '12:30').getTime() - atS(DAY, '11:00:15').getTime());
});

test('Nothing is scheduled for alerts more than a day away, or when alerts are off', () => {
  const far = createTask({
    id: 'far', title: 'far', start: fixed('12:00'), durationMinutes: 30, date: '2026-10-09',
    reminders: { enabled: false, offsets: [], fullScreen: true },
  });
  const w = setup({ tasks: [far], startAt: atS(DAY, '11:00:00') });
  w.tickAt(atS(DAY, '11:00:00'));
  w.tickAt(atS(DAY, '11:00:15'));
  assert.equal(w.live().length, 0);

  const off = setup({ tasks: [task('A', '12:00')], settings: { fullScreenAlerts: false }, startAt: atS(DAY, '11:59:30') });
  off.tickAt(atS(DAY, '11:59:30'));
  off.tickAt(atS(DAY, '11:59:45'));
  assert.equal(off.live().length, 0);
  off.tickAt(atS(DAY, '12:00:15'));
  assert.equal(off.alerts.length, 0);
});

// ---- Rules ------------------------------------------------------------------------------------------------------------
test('The alert takes the place of the plain notification at the start time, but earlier reminders remain', () => {
  const w = setup({ tasks: [task('Study', '12:00', { reminders: { enabled: true, offsets: [10, 0] } })], startAt: atS(DAY, '11:49:45') });
  w.tickAt(atS(DAY, '11:49:45'));
  w.tickAt(atS(DAY, '11:50:00'));
  assert.deepEqual(w.toasts.map((t) => t.payload.lines[0]), ['Starts in 10 min · 12:00 PM']);
  w.tickAt(atS(DAY, '11:59:45'));
  w.clock = at(DAY, '12:00');
  w.live()[0].fn();
  w.tickAt(atS(DAY, '12:00:15'));
  assert.equal(w.toasts.length, 1, 'no "Starts now" notification');
  assert.equal(w.alerts.length, 1);

  const without = setup({ tasks: [task('Study', '12:00', { reminders: { enabled: true, offsets: [10, 0], fullScreen: false } })], startAt: atS(DAY, '11:49:45') });
  without.tickAt(atS(DAY, '11:49:45'));
  without.tickAt(atS(DAY, '11:50:05'));
  without.tickAt(atS(DAY, '12:00:05'));
  assert.equal(without.toasts.length, 2, 'without the alert, both notifications appear');
  assert.equal(without.alerts.length, 0);
});

test('The alert works even when the reminder switch is off, and when notifications are off', () => {
  const quiet = task('Study', '12:00', { reminders: { enabled: false, offsets: [] } });
  const w = setup({ tasks: [quiet], settings: { notificationsEnabled: false }, startAt: atS(DAY, '11:59:30') });
  w.tickAt(atS(DAY, '11:59:30'));
  w.tickAt(atS(DAY, '11:59:45'));
  w.clock = at(DAY, '12:00');
  w.live()[0].fn();
  assert.equal(w.alerts.length, 1);
  assert.equal(w.toasts.length, 0);
});

test('Switching all full-screen alerts off in Settings brings back the plain notification at the start', () => {
  const t = task('Study', '12:00', { reminders: { enabled: true, offsets: [0] } });
  const w = setup({ tasks: [t], settings: { fullScreenAlerts: false }, startAt: atS(DAY, '11:59:45') });
  w.tickAt(atS(DAY, '11:59:45'));
  w.tickAt(atS(DAY, '12:00:05'));
  assert.equal(w.alerts.length, 0);
  assert.equal(w.toasts.length, 1);
});

test('A task marked done before its start gets no alert', () => {
  const w = setup({ tasks: [setCompletion(task('Study', '12:00'), DAY, true)], startAt: atS(DAY, '11:59:30') });
  w.tickAt(atS(DAY, '11:59:30'));
  w.tickAt(atS(DAY, '12:00:05'));
  assert.equal(w.alerts.length, 0);
});

test('Tasks that start relative to a prayer or another task get the alert at their resolved start', () => {
  const asr = createTask({
    id: 'asr', title: 'After Asr', start: { mode: 'prayer', prayer: 'asr', direction: 'after', minutes: 10 },
    durationMinutes: 20, date: DAY, reminders: { enabled: false, offsets: [], fullScreen: true },
  });
  const then = createTask({
    id: 'then', title: 'Then', start: { mode: 'task', taskId: 'asr', point: 'end', direction: 'after', minutes: 5, fallbackTime: '09:00' },
    durationMinutes: 20, date: DAY, reminders: { enabled: false, offsets: [], fullScreen: true },
  });
  const list = alertsInWindow(provider, [asr, then], at(DAY, '14:00').getTime(), at(DAY, '17:00').getTime(), {});
  assert.deepEqual(list.map((a) => [a.title, formatTime12(a.start)]), [['After Asr', '3:24 PM'], ['Then', '3:49 PM']]);
});

// ---- Too late ---------------------------------------------------------------------------------------------------------------
test('If the computer was off or asleep at the start time there is no late alert; it goes into the missed summary', () => {
  const w = setup({
    tasks: [task('Study', '12:00')],
    startAt: at(DAY, '12:05'),
    initialState: { ...emptyState(), lastTickAt: at(DAY, '11:00').getTime() },
  });
  w.tickAt(at(DAY, '12:05'));
  assert.equal(w.alerts.length, 0);
  assert.deepEqual((w.missed || []).map((m) => m.title), ['Study']);
});

test('A check that is only a few seconds late still shows the alert, but 16 seconds late does not', () => {
  const make = () => setup({
    tasks: [task('Study', '12:00')],
    startAt: atS(DAY, '12:00:10'),
    initialState: { ...emptyState(), lastTickAt: atS(DAY, '11:59:50').getTime() },
  });
  const ok = make();
  ok.tickAt(atS(DAY, '12:00:14'));
  assert.equal(ok.alerts.length, 1);
  const late = make();
  late.tickAt(atS(DAY, '12:00:16'));
  assert.equal(late.alerts.length, 0);
});

// ---- Snooze and Mark as Done from the alert ------------------------------------------------------------------------------------
test('Snooze from the alert brings the alert back, as an alert, exactly when the snooze ends', () => {
  const w = setup({ tasks: [task('Study', '12:00')], startAt: atS(DAY, '11:59:30') });
  w.tickAt(atS(DAY, '11:59:30'));
  w.tickAt(atS(DAY, '11:59:45'));
  w.clock = at(DAY, '12:00');
  w.live()[0].fn();
  assert.equal(w.alerts.length, 1);

  w.clock = atS(DAY, '12:00:20');
  const snoozed = w.engine.handleAction({ type: 'snooze', taskId: 'Study', dateKey: DAY, fullScreen: true });
  assert.equal(formatTime12(snoozed.until), '12:05 PM');
  const timer = w.live()[0];
  assert.equal(timer.ms, 300000, 'a timer for exactly 5 minutes after the click (12:05:20)');

  w.clock = atS(DAY, '12:05:20');
  timer.fn();
  assert.equal(w.alerts.length, 2);
  assert.equal(w.alerts[1].items[0].snoozed, true);
  assert.equal(w.toasts.length, 0, 'it comes back as an alert, not a notification');
});

test('Snooze from a plain notification still comes back as a plain notification', () => {
  const t = task('Study', '12:00', { reminders: { enabled: true, offsets: [15], fullScreen: false } });
  const w = setup({ tasks: [t], startAt: atS(DAY, '11:44:30') });
  w.tickAt(atS(DAY, '11:44:30'));
  w.tickAt(atS(DAY, '11:45:05'));
  assert.equal(w.toasts.length, 1);
  w.clock = atS(DAY, '11:46:00');
  w.engine.handleAction({ type: 'snooze', taskId: 'Study', dateKey: DAY });
  w.tickAt(atS(DAY, '11:51:05'));
  assert.equal(w.toasts.length, 2);
  assert.equal(w.alerts.length, 0);
});

test('Mark as Done after the alert stops a snoozed alert', () => {
  const w = setup({ tasks: [task('Study', '12:00')], startAt: atS(DAY, '11:59:30') });
  w.tickAt(atS(DAY, '11:59:30'));
  w.tickAt(atS(DAY, '11:59:45'));
  w.clock = at(DAY, '12:00');
  w.live()[0].fn();
  w.clock = atS(DAY, '12:00:30');
  w.engine.handleAction({ type: 'snooze', taskId: 'Study', dateKey: DAY, fullScreen: true });
  w.engine.handleAction({ type: 'done', taskId: 'Study', dateKey: DAY });
  w.tickAt(atS(DAY, '12:06:00'));
  assert.equal(w.alerts.length, 1, 'only the original alert');
});

test('An error while showing the alert does not stop the engine', () => {
  const w = setup({ tasks: [task('A', '12:00'), task('B', '12:30')], startAt: atS(DAY, '11:59:30') });
  w.engine.deps.showAlert = () => { throw new Error('window failed'); };
  w.tickAt(atS(DAY, '11:59:30'));
  w.tickAt(atS(DAY, '11:59:45'));
  w.clock = at(DAY, '12:00');
  w.live()[0].fn();
  assert.equal(w.errors.length, 1);
  assert.equal(w.live().length, 1, 'the timer for 12:30 is still set');
});
