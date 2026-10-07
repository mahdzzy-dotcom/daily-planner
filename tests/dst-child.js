'use strict';

// Runs in its own process with the time zone set to Egypt (see dst.test.js).
// Prints what happens around the daylight saving changes of 2026.

const core = require('../src/core');
const { createTask, getOccurrences, computeDayLayout, ReminderEngine, formatTime12 } = core;

function local(key, h, m) {
  const [y, mo, d] = key.split('-').map(Number);
  return new Date(y, mo - 1, d, h, m, 0, 0);
}

// The same prayer clock times every day (local wall-clock times).
const provider = (key) => ({
  fajr: local(key, 5, 5), dhuhr: local(key, 11, 48), asr: local(key, 15, 14), maghrib: local(key, 18, 0), isha: local(key, 19, 20),
});

const offsetOf = (date) => -date.getTimezoneOffset();
const result = { hasDst: offsetOf(new Date(2026, 6, 1)) !== offsetOf(new Date(2026, 0, 1)) };

if (result.hasDst) {
  // 1. A daily 9:00 AM task keeps its wall-clock time through the "fall back" (clocks go back at midnight, Oct 29 -> 30)
  const daily = createTask({
    id: 'd', title: 'Daily', start: { mode: 'fixed', time: '09:00' }, durationMinutes: 60,
    recurrence: { startDate: '2026-10-27', frequency: 'daily', interval: 1 },
    reminders: { enabled: true, offsets: [60] },
  });
  const occ = getOccurrences(provider, daily, '2026-10-28', '2026-10-31');
  result.fallBack = occ.map((o) => ({
    date: o.dateKey,
    start: formatTime12(o.start),
    end: formatTime12(o.end),
    realMinutesToNext: null,
    startMs: o.start.getTime(),
  }));
  result.fallBack.forEach((o, i) => {
    if (i < result.fallBack.length - 1) o.realMinutesToNext = (result.fallBack[i + 1].startMs - o.startMs) / 60000;
  });

  // 2. Zone 5 is longer by an hour on the night the clocks go back, shorter on the night they go forward
  const zone5 = (key) => computeDayLayout(provider, key, []).zones[4].totalMinutes;
  result.zone5 = { normal: zone5('2026-10-27'), fallBack: zone5('2026-10-29'), springForward: zone5('2026-04-23') };

  // 3. An end time is always start + duration in real minutes
  const late = createTask({ id: 'l', title: 'Late', start: { mode: 'fixed', time: '23:30' }, durationMinutes: 90, date: '2026-10-29' });
  const [lateOcc] = getOccurrences(provider, late, '2026-10-29', '2026-10-29');
  result.late = { end: formatTime12(lateOcc.end), realMinutes: (lateOcc.end - lateOcc.start) / 60000 };

  // 4. The reminder engine does not repeat a notification when the same clock time happens twice
  const repeated = createTask({
    id: 'r', title: 'Repeated hour', start: { mode: 'fixed', time: '23:30' }, durationMinutes: 30, date: '2026-10-29',
    reminders: { enabled: true, offsets: [0] },
  });
  const shown = [];
  const engine = new ReminderEngine({
    getTasks: () => [repeated],
    getProvider: () => provider,
    getSettings: () => ({}),
    notify: (payload) => shown.push(payload.title),
    updateTask: () => {},
    now: () => new Date(),
  });
  // Cairo is UTC+3 until the change, then UTC+2: 23:30 happens at 20:30Z and again at 21:30Z
  engine.tick(new Date('2026-10-29T20:25:00Z'));
  engine.tick(new Date('2026-10-29T20:30:10Z'));
  engine.tick(new Date('2026-10-29T21:25:00Z'));
  engine.tick(new Date('2026-10-29T21:30:10Z'));
  result.repeatedHourNotifications = shown.length;

  // 5. Spring forward: a task at 00:30 on the day clocks jump from 00:00 to 01:00 still resolves to a real time
  const jump = createTask({ id: 'j', title: 'Jump', start: { mode: 'fixed', time: '09:00' }, durationMinutes: 30, date: '2026-04-24' });
  const [jumpOcc] = getOccurrences(provider, jump, '2026-04-24', '2026-04-24');
  result.springForward = { start: formatTime12(jumpOcc.start), hour: jumpOcc.start.getHours() };
}

process.stdout.write(JSON.stringify(result));
