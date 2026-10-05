'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ReminderEngine,
  emptyState,
  createTask,
  setCompletion,
  formatTime12,
} = require('../src/core');
const { at, atS, provider } = require('./helpers');

const DAY = '2026-10-04';
const fixed = (time) => ({ mode: 'fixed', time });
const reminders = (offsets) => ({ enabled: true, offsets });

function task(id, time, offsets, date = DAY, extra = {}) {
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

// A fake world: a clock we control, and recorders for everything the engine does.
function setup(options = {}) {
  const world = {
    clock: options.startAt || at(DAY, '08:00'),
    tasks: options.tasks || [],
    provider: options.provider || provider,
    settings: options.settings || {},
    notified: [], // { at: Date, payload }
    missed: [], // { items, payload }
    saves: [],
    errors: [],
  };
  world.engine = new ReminderEngine({
    getTasks: () => world.tasks,
    getProvider: () => world.provider,
    getSettings: () => world.settings,
    notify: (payload) => world.notified.push({ at: world.clock, payload }),
    onMissed: (items, payload) => world.missed.push({ items, payload }),
    updateTask: (updated) => {
      world.tasks = world.tasks.map((t) => (t.id === updated.id ? updated : t));
    },
    saveState: (state) => world.saves.push(state),
    onError: (error) => world.errors.push(error),
    now: () => world.clock,
    initialState: options.initialState,
  });
  // Move the fake clock and run one check.
  world.tickAt = (date) => {
    world.clock = date;
    return world.engine.tick(date);
  };
  // Run checks every 15 seconds from one time to another (like the real background timer).
  world.run = (fromDate, toDate) => {
    for (let t = fromDate.getTime(); t <= toDate.getTime(); t += 15000) world.tickAt(new Date(t));
  };
  return world;
}

const clockText = (entry) => formatTime12(entry.at);

// ---- Normal operation (scenario 18 in action) ------------------------------------------------------------
test('Reminders fire on time, once each, with the right content', () => {
  const w = setup({ tasks: [task('Study', '09:00', [15, 0])], startAt: at(DAY, '08:40') });
  w.run(at(DAY, '08:40'), at(DAY, '09:10'));

  assert.equal(w.notified.length, 2);
  assert.deepEqual(w.notified.map(clockText), ['8:45 AM', '9:00 AM']);
  assert.deepEqual(w.notified.map((n) => n.payload.lines[0]), ['Starts in 15 min · 9:00 AM', 'Starts now · 9:00 AM']);
  assert.ok(w.notified.every((n) => n.payload.title === 'Study'));
  assert.ok(w.notified.every((n) => n.payload.lines[1] === 'Zone: Fajr → Dhuhr'));
  assert.equal(w.missed.length, 0);
});

test('Notifications fire within one check interval of the exact time', () => {
  const w = setup({ tasks: [task('Study', '09:00', [0])], startAt: at(DAY, '08:59') });
  w.run(at(DAY, '08:59'), at(DAY, '09:01'));
  assert.equal(w.notified.length, 1);
  const delay = w.notified[0].at.getTime() - at(DAY, '09:00').getTime();
  assert.ok(delay >= 0 && delay < 15000, `delay was ${delay} ms`);
});

test('Prayer-relative tasks notify at the resolved time, and a daily task notifies every day', () => {
  const t = createTask({
    id: 'asr',
    title: 'After Asr',
    start: { mode: 'prayer', prayer: 'asr', direction: 'after', minutes: 10 },
    durationMinutes: 20,
    recurrence: { startDate: DAY, frequency: 'daily', interval: 1 },
    reminders: reminders([0]),
  });
  const w = setup({ tasks: [t], startAt: at(DAY, '15:00') });
  w.run(at(DAY, '15:00'), at(DAY, '15:30'));
  w.run(at('2026-10-05', '15:00'), at('2026-10-05', '15:30'));
  assert.deepEqual(w.notified.map(clockText), ['3:24 PM', '3:22 PM']);
});

test('Reminder on with an empty list uses the default offset; reminder off stays silent', () => {
  const onEmpty = createTask({
    id: 'e',
    title: 'e',
    start: fixed('09:00'),
    durationMinutes: 30,
    date: DAY,
    reminders: { enabled: true, offsets: [] },
  });
  const off = createTask({ id: 'o', title: 'o', start: fixed('09:30'), durationMinutes: 30, date: DAY });
  const w = setup({ tasks: [onEmpty, off], startAt: at(DAY, '08:00') });
  w.run(at(DAY, '08:00'), at(DAY, '10:00'));
  assert.deepEqual(w.notified.map((n) => `${n.payload.title} ${clockText(n)}`), ['e 8:50 AM']);
});

test('Sound off makes notifications silent', () => {
  const w = setup({ tasks: [task('s', '09:00', [0])], settings: { soundEnabled: false }, startAt: at(DAY, '08:59') });
  w.run(at(DAY, '08:59'), at(DAY, '09:01'));
  assert.equal(w.notified[0].payload.silent, true);
});

// ---- Scenario 19 (logic part): runs without any window ------------------------------------------------------------
test('19. The engine needs no window or UI: it starts, ticks on its own timer, and stops cleanly', () => {
  const callbacks = [];
  const cleared = [];
  const w = setup({ tasks: [task('bg', '09:00', [0])], startAt: atS(DAY, '08:59:00') });
  // Replace the timer functions with fakes that we can fire by hand
  w.engine.deps.setInterval = (fn, ms) => {
    callbacks.push({ fn, ms });
    return 42;
  };
  w.engine.deps.clearInterval = (id) => cleared.push(id);

  w.engine.start();
  assert.equal(callbacks.length, 1);
  assert.equal(callbacks[0].ms, 15000, 'checks every 15 seconds');

  w.clock = at(DAY, '09:00');
  callbacks[0].fn(); // the timer fires; no window involved
  assert.equal(w.notified.length, 1);

  w.engine.stop();
  assert.deepEqual(cleared, [42]);
  assert.ok(w.saves.length > 0, 'state is saved when stopping');
});

// ---- Scenario 20: missed reminders -----------------------------------------------------------------------------------
test('20. After the PC was off, launch shows ONE summary of missed reminders (not completed ones)', () => {
  const tasks = [
    task('A', '09:00', [15, 0]),
    setCompletion(task('B', '08:30', [0]), DAY, true),
    task('C', '09:30', [0]),
    task('Later', '14:00', [0]), // not due yet
  ];
  const w = setup({
    tasks,
    startAt: at(DAY, '12:00'),
    initialState: { ...emptyState(), lastTickAt: at(DAY, '08:00').getTime() },
  });
  const result = w.tickAt(at(DAY, '12:00'));

  assert.equal(w.notified.length, 0, 'nothing shown as a normal notification');
  assert.equal(w.missed.length, 1, 'one summary');
  const items = w.missed[0].items;
  assert.deepEqual(items.map((i) => i.title), ['A', 'C']);
  assert.equal(formatTime12(items[0].notifyAt), '8:45 AM');
  assert.ok(items.every((i) => i.alreadyStarted));
  assert.equal(w.missed[0].payload.title, 'You missed 2 reminders');
  assert.equal(result.missed.length, 2);

  // The same reminders are never reported twice
  w.tickAt(atS(DAY, '12:00:15'));
  w.tickAt(atS(DAY, '12:00:30'));
  assert.equal(w.missed.length, 1);
});

test('20b. Only roughly the previous 24 hours are reported', () => {
  const tasks = [
    task('TooOld', '07:00', [0], '2026-10-03'),
    task('Recent', '18:00', [0], '2026-10-03'),
  ];
  const w = setup({
    tasks,
    startAt: at(DAY, '12:00'),
    initialState: { ...emptyState(), lastTickAt: at('2026-10-01', '12:00').getTime() },
  });
  w.tickAt(at(DAY, '12:00'));
  assert.deepEqual(w.missed[0].items.map((i) => i.title), ['Recent']);
});

test('20c. Waking from sleep: a long gap between checks produces the summary', () => {
  const w = setup({ tasks: [task('A', '09:00', [0])], startAt: at(DAY, '08:30') });
  w.run(at(DAY, '08:30'), at(DAY, '08:40'));
  // computer sleeps ... wakes at 9:30
  w.clock = at(DAY, '09:30');
  w.engine.onSystemChange();
  assert.equal(w.notified.length, 0);
  assert.equal(w.missed.length, 1);
  assert.deepEqual(w.missed[0].items.map((i) => i.title), ['A']);
});

test('20d. A reminder only slightly late is shown normally; an older one for the same task is not repeated as "missed"', () => {
  const w = setup({
    tasks: [task('A', '09:00', [15, 0])],
    startAt: at(DAY, '09:01'),
    initialState: { ...emptyState(), lastTickAt: at(DAY, '08:00').getTime() },
  });
  w.tickAt(at(DAY, '09:01'));
  assert.equal(w.notified.length, 1, 'the 9:00 reminder, one minute late');
  assert.equal(w.missed.length, 0, 'the 8:45 one is covered by the notification just shown');
});

test('20e. The grace period is 2 minutes', () => {
  const make = () =>
    setup({
      tasks: [task('A', '09:00', [0])],
      startAt: at(DAY, '09:02'),
      initialState: { ...emptyState(), lastTickAt: at(DAY, '08:59').getTime() },
    });
  const onTime = make();
  onTime.tickAt(at(DAY, '09:02')); // exactly 2 minutes late
  assert.equal(onTime.notified.length, 1);
  assert.equal(onTime.missed.length, 0);

  const late = make();
  late.tickAt(new Date(at(DAY, '09:02').getTime() + 1000)); // 2 minutes 1 second late
  assert.equal(late.notified.length, 0);
  assert.equal(late.missed.length, 1);
});

test('20f. The very first run never reports missed reminders', () => {
  const w = setup({ tasks: [task('A', '07:00', [0])], startAt: at(DAY, '12:00') });
  w.tickAt(at(DAY, '12:00'));
  assert.equal(w.missed.length, 0);
  assert.equal(w.notified.length, 0);
});

// ---- Scenario 29: zone-start notifications ---------------------------------------------------------------------------------
test('29. Zone-start notifications fire at the prayer time when switched on, and only then', () => {
  const on = setup({ settings: { zoneStartNotifications: true }, startAt: at(DAY, '15:10') });
  on.run(at(DAY, '15:10'), at(DAY, '15:20'));
  assert.equal(on.notified.length, 1);
  assert.equal(on.notified[0].payload.title, 'Asr → Maghrib has started');
  assert.deepEqual(on.notified[0].payload.lines, ['Until 6:00 PM']);
  assert.equal(formatTime12(on.notified[0].at).slice(0, 4), '3:14');

  const off = setup({ settings: { zoneStartNotifications: false }, startAt: at(DAY, '15:10') });
  off.run(at(DAY, '15:10'), at(DAY, '15:20'));
  assert.equal(off.notified.length, 0, 'default is Off');
});

test('29b. Asleep through a prayer time: no late Zone notification and nothing in the missed summary', () => {
  const w = setup({
    settings: { zoneStartNotifications: true },
    tasks: [task('Task during Asr', '15:20', [10])], // its reminder (15:10) is also missed
    startAt: at(DAY, '15:00'),
  });
  w.run(at(DAY, '15:00'), at(DAY, '15:05'));
  w.clock = at(DAY, '15:30'); // wake up
  w.engine.onSystemChange();

  assert.ok(w.notified.every((n) => n.payload.kind !== 'zone'), 'no late Zone notification');
  assert.equal(w.missed.length, 1);
  assert.deepEqual(w.missed[0].items.map((i) => i.title), ['Task during Asr'], 'only task reminders are listed');
});

test('29c. A whole day asleep produces no Zone notifications at all', () => {
  const w = setup({
    settings: { zoneStartNotifications: true },
    startAt: at(DAY, '04:00'),
    initialState: { ...emptyState(), lastTickAt: at(DAY, '04:00').getTime() },
  });
  w.tickAt(at(DAY, '21:00'));
  assert.equal(w.notified.length, 0);
  assert.equal(w.missed.length, 0);
});

// ---- Snooze and Mark as Done -----------------------------------------------------------------------------------------------
test('Snooze re-notifies after the snooze time, once', () => {
  const w = setup({ tasks: [task('Study', '09:00', [15, 0])], startAt: at(DAY, '08:40') });
  w.run(at(DAY, '08:40'), at(DAY, '08:46'));
  assert.equal(w.notified.length, 1);

  w.clock = at(DAY, '08:46');
  const result = w.engine.handleAction({ type: 'snooze', taskId: 'Study', dateKey: DAY });
  assert.equal(formatTime12(result.until), '8:51 AM');

  w.run(new Date(at(DAY, '08:46').getTime() + 15000), atS(DAY, '08:50:45'));
  assert.equal(w.notified.length, 1, 'not yet');

  w.run(at(DAY, '08:50'), at(DAY, '08:52'));
  assert.equal(w.notified.length, 2);
  const snoozed = w.notified[1].payload;
  assert.equal(snoozed.kind, 'snooze');
  assert.equal(snoozed.title, 'Study');
  assert.equal(snoozed.lines[0], 'Starts in 9 min · 9:00 AM');
  assert.equal(w.engine.state.snoozed.length, 0);

  w.run(at(DAY, '08:52'), at(DAY, '09:05'));
  assert.equal(w.notified.length, 3, 'the normal 9:00 reminder still fires, and nothing repeats');
  assert.equal(w.notified[2].payload.lines[0], 'Starts now · 9:00 AM');
});

test('Snooze uses the snooze length from Settings', () => {
  const w = setup({ tasks: [task('S', '09:00', [0])], settings: { snoozeMinutes: 10 }, startAt: at(DAY, '09:00') });
  w.clock = at(DAY, '09:00');
  const result = w.engine.handleAction({ type: 'snooze', taskId: 'S', dateKey: DAY });
  assert.equal(formatTime12(result.until), '9:10 AM');
});

test('Marking done before a snoozed reminder fires cancels it, and later reminders too', () => {
  const w = setup({ tasks: [task('Study', '09:00', [15, 0])], startAt: at(DAY, '08:40') });
  w.run(at(DAY, '08:40'), at(DAY, '08:46'));
  w.clock = at(DAY, '08:46');
  w.engine.handleAction({ type: 'snooze', taskId: 'Study', dateKey: DAY });

  w.clock = at(DAY, '08:47');
  const done = w.engine.handleAction({ type: 'done', taskId: 'Study', dateKey: DAY });
  assert.equal(done.ok, true);
  assert.equal(w.tasks[0].completions[DAY], true);
  assert.equal(w.engine.state.snoozed.length, 0);

  w.run(at(DAY, '08:47'), at(DAY, '09:10'));
  assert.equal(w.notified.length, 1, 'only the first reminder was shown');
});

test('A snooze for a task that was deleted meanwhile is dropped quietly', () => {
  const w = setup({ tasks: [task('Gone', '09:00', [0])], startAt: at(DAY, '08:50') });
  w.clock = at(DAY, '08:50');
  w.engine.handleAction({ type: 'snooze', taskId: 'Gone', dateKey: DAY });
  w.tasks = [];
  w.run(at(DAY, '08:50'), at(DAY, '09:00'));
  assert.equal(w.notified.length, 0);
  assert.equal(w.engine.state.snoozed.length, 0);
});

test('A snooze that came due while the app was closed appears in the missed summary', () => {
  const w = setup({
    tasks: [task('Study', '12:00', [0])],
    startAt: at(DAY, '10:00'),
    initialState: {
      ...emptyState(),
      lastTickAt: at(DAY, '08:46').getTime(),
      snoozed: [{ taskId: 'Study', dateKey: DAY, until: at(DAY, '08:51').getTime() }],
    },
  });
  w.tickAt(at(DAY, '10:00'));
  assert.equal(w.notified.length, 0);
  assert.equal(w.missed.length, 1);
  assert.deepEqual(w.missed[0].items.map((i) => i.title), ['Study']);
});

test('Actions: unknown task and unknown action', () => {
  const w = setup({ tasks: [task('A', '09:00', [0])] });
  assert.deepEqual(w.engine.handleAction({ type: 'done', taskId: 'nope', dateKey: DAY }), { type: 'done', ok: false });
  assert.throws(() => w.engine.handleAction({ type: 'explode', taskId: 'A', dateKey: DAY }));
});

// ---- Settings and system changes (scenarios 23-24 in spirit) ----------------------------------------------------------------------
test('Notifications switched off: nothing is shown, and nothing shows up retroactively when switched on', () => {
  const w = setup({
    tasks: [task('A', '09:00', [0])],
    settings: { notificationsEnabled: false },
    startAt: at(DAY, '08:50'),
  });
  w.run(at(DAY, '08:50'), at(DAY, '09:30'));
  assert.equal(w.notified.length, 0);
  assert.equal(w.missed.length, 0);

  w.settings = { notificationsEnabled: true };
  w.run(at(DAY, '09:30'), at(DAY, '09:40'));
  assert.equal(w.notified.length, 0);
  assert.equal(w.missed.length, 0);
});

test('A prayer-time adjustment moves upcoming notifications immediately', () => {
  const t = createTask({
    id: 'asr',
    title: 'At Asr',
    start: { mode: 'prayer', prayer: 'asr', direction: 'after', minutes: 0 },
    durationMinutes: 20,
    date: DAY,
    reminders: reminders([0]),
  });
  const shifted = (key) => {
    const times = provider(key);
    return { ...times, asr: new Date(times.asr.getTime() + 5 * 60000) }; // Asr +5 minutes
  };

  const w = setup({ tasks: [t], startAt: at(DAY, '15:00') });
  assert.equal(formatTime12(w.engine.upcoming(1, at(DAY, '15:00'))[0].notifyAt), '3:14 PM');

  w.run(at(DAY, '15:00'), at(DAY, '15:10'));
  w.provider = shifted; // the user changed the Asr adjustment in Settings
  assert.equal(formatTime12(w.engine.upcoming(1, at(DAY, '15:10'))[0].notifyAt), '3:19 PM');

  w.run(at(DAY, '15:10'), at(DAY, '15:16'));
  assert.equal(w.notified.length, 0, 'not at the old time');
  w.run(at(DAY, '15:16'), at(DAY, '15:22'));
  assert.equal(w.notified.length, 1);
  assert.ok(formatTime12(w.notified[0].at).startsWith('3:19'));
});

test('Editing a task moves its notification', () => {
  const w = setup({ tasks: [task('Move', '09:00', [0])], startAt: at(DAY, '08:50') });
  w.run(at(DAY, '08:50'), at(DAY, '08:55'));
  w.tasks = [{ ...w.tasks[0], start: fixed('10:00') }];
  w.run(at(DAY, '08:55'), at(DAY, '10:05'));
  assert.deepEqual(w.notified.map(clockText), ['10:00 AM']);
});

test('upcoming() lists the next reminders in order', () => {
  const w = setup({ tasks: [task('A', '09:00', [15, 0]), task('B', '08:00', [0])], startAt: at(DAY, '07:00') });
  const list = w.engine.upcoming(5, at(DAY, '07:00'));
  assert.deepEqual(list.map((r) => `${r.title} ${formatTime12(r.notifyAt)}`), ['B 8:00 AM', 'A 8:45 AM', 'A 9:00 AM']);
});

// ---- Robustness -----------------------------------------------------------------------------------------------------------------
test('Setting the clock back never repeats a notification', () => {
  const w = setup({ tasks: [task('A', '09:00', [0])], startAt: at(DAY, '08:59') });
  w.run(at(DAY, '08:59'), atS(DAY, '09:00:15'));
  w.run(new Date(at(DAY, '09:00').getTime() + 15000), new Date(at(DAY, '09:00').getTime() + 30000));
  assert.equal(w.notified.length, 1);

  w.run(at(DAY, '08:50'), at(DAY, '09:01')); // clock jumps back 10 minutes, then runs forward again
  assert.equal(w.notified.length, 1, 'still just one');
  assert.equal(w.missed.length, 0);
});

test('A failing notification does not stop the engine', () => {
  const w = setup({ tasks: [task('A', '09:00', [0]), task('B', '09:01', [0])], startAt: at(DAY, '08:59') });
  let calls = 0;
  w.engine.deps.notify = () => {
    calls += 1;
    throw new Error('Windows said no');
  };
  w.run(at(DAY, '08:59'), at(DAY, '09:02'));
  assert.equal(calls, 2, 'both reminders were attempted');
  assert.equal(w.errors.length, 2);
});

test('State is saved when something is delivered, and a restarted engine does not repeat it', () => {
  const w = setup({ tasks: [task('A', '09:00', [0])], startAt: at(DAY, '08:59') });
  w.run(at(DAY, '08:59'), atS(DAY, '09:00:30'));
  w.tickAt(new Date(at(DAY, '09:00').getTime() + 15000));
  assert.equal(w.notified.length, 1);

  const saved = w.saves[w.saves.length - 1];
  assert.equal(Object.keys(saved.delivered).length, 1);

  // Restart with a slightly stale "last checked" time, as after a power cut
  const restarted = setup({
    tasks: w.tasks,
    startAt: at(DAY, '09:00'),
    initialState: { ...saved, lastTickAt: atS(DAY, '08:59:10').getTime() },
  });
  restarted.tickAt(new Date(at(DAY, '09:00').getTime() + 30000));
  assert.equal(restarted.notified.length, 0, 'no duplicate after restart');
  assert.equal(restarted.missed.length, 0);
});

test('The "last checked" time is not written to disk on every check', () => {
  const w = setup({ startAt: at(DAY, '08:00') });
  w.run(at(DAY, '08:00'), at(DAY, '08:10')); // 41 checks
  assert.ok(w.saves.length <= 14, `saves: ${w.saves.length}`);
  assert.ok(w.saves.length >= 2);
});

test('Old delivery records are forgotten after two days', () => {
  const w = setup({
    startAt: at(DAY, '12:00'),
    initialState: {
      ...emptyState(),
      lastTickAt: at(DAY, '11:59').getTime(),
      delivered: { old: at('2026-10-01', '12:00').getTime(), fresh: at('2026-10-04', '11:00').getTime() },
    },
  });
  w.tickAt(at(DAY, '12:00'));
  assert.deepEqual(Object.keys(w.engine.state.delivered), ['fresh']);
});
