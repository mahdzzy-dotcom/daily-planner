'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveZone,
  currentPlanningDayKey,
  resolvePrayerRelative,
  computeEnd,
  computeDayLayout,
  mergeIntervals,
  formatDuration,
  formatTime12,
} = require('../src/core');
const { at, provider } = require('./helpers');

const DAY = '2026-10-04';

function task(id, title, startKey, startHHMM, minutes) {
  const start = at(startKey, startHHMM);
  return { id, title, start, end: computeEnd(start, minutes) };
}

// ---- Scenario 1: zone derivation -------------------------------------------
test('1. Zone derivation for typical times', () => {
  const cases = [
    ['09:00', 1],
    ['12:00', 2],
    ['16:00', 3],
    ['18:30', 4],
    ['20:00', 5],
  ];
  for (const [time, expected] of cases) {
    const result = deriveZone(provider, at(DAY, time));
    assert.equal(result.zoneIndex, expected, `${time} should be zone ${expected}`);
    assert.equal(result.planningDayKey, DAY);
  }
});

// ---- Scenario 2: boundary inclusivity ----------------------------------------
test('2. A moment exactly at a prayer time belongs to the zone that starts there', () => {
  assert.equal(deriveZone(provider, at(DAY, '11:48')).zoneIndex, 2);
  assert.equal(deriveZone(provider, at(DAY, '11:47')).zoneIndex, 1);
  assert.equal(deriveZone(provider, at(DAY, '05:05')).zoneIndex, 1);
  assert.equal(deriveZone(provider, at(DAY, '19:20')).zoneIndex, 5);
});

// ---- Scenario 3: after-midnight task -----------------------------------------
test('3. 2:00 AM on Oct 5 is Zone 5 of the Planning Day that began Oct 4', () => {
  const result = deriveZone(provider, at('2026-10-05', '02:00'));
  assert.equal(result.zoneIndex, 5);
  assert.equal(result.planningDayKey, '2026-10-04');
});

// ---- Scenario 4: zone totals --------------------------------------------------
test('4. Zone totals (Zone 1 is 6h 43m) and all five zones add up to a full Planning Day', () => {
  const layout = computeDayLayout(provider, DAY, []);
  assert.equal(layout.zones.length, 5);
  assert.equal(layout.zones[0].totalLabel, '6h 43m');
  assert.equal(layout.zones[1].totalLabel, '3h 26m');
  assert.equal(layout.zones[2].totalLabel, '2h 46m');
  assert.equal(layout.zones[3].totalLabel, '1h 20m');
  assert.equal(layout.zones[4].totalLabel, '9h 46m');
  const sum = layout.zones.reduce((s, z) => s + z.totalMinutes, 0);
  assert.equal(sum, 24 * 60 + 1); // Fajr 5:05 AM -> next Fajr 5:06 AM
  // Empty zones still show their full free duration
  assert.equal(layout.zones[0].scheduledLabel, '0m');
  assert.equal(layout.zones[0].freeLabel, '6h 43m');
});

// ---- Scenario 5: duration figures ---------------------------------------------
test('5. Scheduled 3h 10m leaves Free 3h 33m in Zone 1', () => {
  const tasks = [
    task('a', 'Morning Routine', DAY, '07:00', 45),
    task('b', 'Study SQL', DAY, '08:00', 90),
    task('c', 'Exercise', DAY, '10:00', 55),
  ];
  const zone1 = computeDayLayout(provider, DAY, tasks).zones[0];
  assert.equal(zone1.scheduledLabel, '3h 10m');
  assert.equal(zone1.freeLabel, '3h 33m');
  assert.equal(zone1.totalLabel, '6h 43m');
  assert.deepEqual(
    zone1.tasks.map((t) => t.id),
    ['a', 'b', 'c'],
    'tasks are sorted by start time'
  );
});

// ---- Scenario 6: overlap merge --------------------------------------------------
test('6. Overlapping tasks are merged in Scheduled Duration and both are flagged', () => {
  const tasks = [
    task('a', 'First', DAY, '09:00', 60),
    task('b', 'Second', DAY, '09:30', 60),
    task('c', 'Separate', DAY, '11:00', 30),
  ];
  const zone1 = computeDayLayout(provider, DAY, tasks).zones[0];
  assert.equal(zone1.scheduledMinutes, 90 + 30); // 9:00-10:30 merged, plus 11:00-11:30
  const byId = Object.fromEntries(zone1.tasks.map((t) => [t.id, t]));
  assert.equal(byId.a.overlaps, true);
  assert.equal(byId.b.overlaps, true);
  assert.equal(byId.c.overlaps, false);
});

test('6b. mergeIntervals handles nested and touching intervals', () => {
  const merged = mergeIntervals([
    { start: at(DAY, '09:00'), end: at(DAY, '12:00') },
    { start: at(DAY, '10:00'), end: at(DAY, '11:00') },
    { start: at(DAY, '12:00'), end: at(DAY, '13:00') },
    { start: at(DAY, '15:00'), end: at(DAY, '16:00') },
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].end.getTime(), at(DAY, '13:00').getTime());
});

// ---- Scenario 7: boundary-crossing split -----------------------------------------
test('7. A task crossing Dhuhr is listed in Zone 1 and split 18 / 42 minutes', () => {
  const t = task('x', 'Long call', DAY, '11:30', 60);
  const layout = computeDayLayout(provider, DAY, [t]);
  const [zone1, zone2] = layout.zones;

  assert.equal(zone1.tasks.length, 1);
  assert.equal(zone1.tasks[0].extendsPastZoneEnd, true);
  assert.equal(zone1.tasks[0].minutesInZone, 18);
  assert.equal(zone1.scheduledMinutes, 18);

  assert.equal(zone2.tasks.length, 0, 'not listed in the second zone');
  assert.equal(zone2.continued.length, 1);
  assert.equal(zone2.continued[0].title, 'Long call');
  assert.equal(zone2.continued[0].minutesInZone, 42);
  assert.equal(zone2.scheduledMinutes, 42);
});

// ---- Scenario 8: cross-Fajr split --------------------------------------------------
test('8. A Zone 5 task running past the next Fajr counts its overflow in Zone 1 of the next day', () => {
  const t = task('n', 'Late night work', '2026-10-05', '04:30', 60); // 4:30-5:30 AM
  assert.equal(deriveZone(provider, t.start).planningDayKey, DAY);

  const day1 = computeDayLayout(provider, DAY, [t]);
  const zone5 = day1.zones[4];
  assert.equal(zone5.tasks.length, 1);
  assert.equal(zone5.tasks[0].extendsPastZoneEnd, true);
  assert.equal(zone5.scheduledMinutes, 36); // 4:30 -> 5:06

  const day2 = computeDayLayout(provider, '2026-10-05', [t]);
  const zone1 = day2.zones[0];
  assert.equal(zone1.tasks.length, 0);
  assert.equal(zone1.continued.length, 1);
  assert.equal(zone1.scheduledMinutes, 24); // 5:06 -> 5:30
});

// ---- Scenario 9: end time ----------------------------------------------------------
test('9. End Time = Start + Duration, including past midnight', () => {
  const end1 = computeEnd(at(DAY, '09:00'), 60);
  assert.equal(formatTime12(end1), '10:00 AM');

  const end2 = computeEnd(at(DAY, '23:30'), 90);
  assert.equal(formatTime12(end2), '1:00 AM');
  assert.equal(end2.getDate(), 5, 'ends on the next calendar day');

  assert.throws(() => computeEnd(at(DAY, '09:00'), 0));
});

// ---- Scenario 10: prayer-relative start ---------------------------------------------
test('10. "10 minutes after Asr" follows each day\'s Asr time', () => {
  const rel = { prayer: 'asr', direction: 'after', minutes: 10 };
  const d1 = resolvePrayerRelative(provider, '2026-10-04', rel);
  const d2 = resolvePrayerRelative(provider, '2026-10-05', rel);
  assert.equal(formatTime12(d1), '3:24 PM');
  assert.equal(formatTime12(d2), '3:22 PM');
  assert.equal(deriveZone(provider, d1).zoneIndex, 3);
  assert.equal(deriveZone(provider, d2).zoneIndex, 3);
});

test('10b. Other prayer-relative cases', () => {
  const before = resolvePrayerRelative(provider, DAY, {
    prayer: 'dhuhr',
    direction: 'before',
    minutes: 30,
  });
  assert.equal(formatTime12(before), '11:18 AM');
  assert.equal(deriveZone(provider, before).zoneIndex, 1);

  const exact = resolvePrayerRelative(provider, DAY, {
    prayer: 'maghrib',
    direction: 'after',
    minutes: 0,
  });
  assert.equal(formatTime12(exact), '6:00 PM');
  assert.equal(deriveZone(provider, exact).zoneIndex, 4);

  // 5 hours after Isha lands after midnight but stays in Zone 5 of the same Planning Day
  const late = resolvePrayerRelative(provider, DAY, {
    prayer: 'isha',
    direction: 'after',
    minutes: 300,
  });
  assert.equal(formatTime12(late), '12:20 AM');
  const derived = deriveZone(provider, late);
  assert.equal(derived.zoneIndex, 5);
  assert.equal(derived.planningDayKey, DAY);
});

test('10c. Invalid prayer-relative input is rejected', () => {
  assert.throws(() =>
    resolvePrayerRelative(provider, DAY, { prayer: 'sunrise', direction: 'after', minutes: 5 })
  );
  assert.throws(() =>
    resolvePrayerRelative(provider, DAY, { prayer: 'asr', direction: 'around', minutes: 5 })
  );
  assert.throws(() =>
    resolvePrayerRelative(provider, DAY, { prayer: 'asr', direction: 'after', minutes: -5 })
  );
});

// ---- Scenario 11: zone shifts across the year ------------------------------------------
test('11. A daily 5:10 AM task is Zone 5 when Fajr is 5:25 and Zone 1 when Fajr is 5:00', () => {
  const winter = deriveZone(provider, at('2026-01-15', '05:10'));
  assert.equal(winter.zoneIndex, 1);
  assert.equal(winter.planningDayKey, '2026-01-15');

  const summer = deriveZone(provider, at('2026-07-15', '05:10'));
  assert.equal(summer.zoneIndex, 5);
  assert.equal(summer.planningDayKey, '2026-07-14');
});

// ---- Scenario 27: "Today" before Fajr -----------------------------------------------------
test('27. "Today" is the Planning Day containing the current moment', () => {
  assert.equal(currentPlanningDayKey(provider, at('2026-10-05', '02:00')), '2026-10-04');
  assert.equal(deriveZone(provider, at('2026-10-05', '02:00')).zoneIndex, 5);

  assert.equal(currentPlanningDayKey(provider, at('2026-10-05', '05:05')), '2026-10-04');
  assert.equal(currentPlanningDayKey(provider, at('2026-10-05', '05:06')), '2026-10-05');
  assert.equal(deriveZone(provider, at('2026-10-05', '05:06')).zoneIndex, 1);

  assert.equal(currentPlanningDayKey(provider, at('2026-10-04', '14:00')), '2026-10-04');
});

// ---- Formatting helpers ---------------------------------------------------------------------
test('Duration and 12-hour time formatting', () => {
  assert.equal(formatDuration(403), '6h 43m');
  assert.equal(formatDuration(45), '45m');
  assert.equal(formatDuration(0), '0m');
  assert.equal(formatDuration(60), '1h 0m');
  assert.equal(formatTime12(at(DAY, '05:05')), '5:05 AM');
  assert.equal(formatTime12(at(DAY, '12:00')), '12:00 PM');
  assert.equal(formatTime12(at(DAY, '00:20')), '12:20 AM');
  assert.equal(formatTime12(at(DAY, '23:59')), '11:59 PM');
});
