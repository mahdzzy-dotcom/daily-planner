'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  generateDates,
  previewDates,
  describeRule,
  validateRule,
  normalizeRule,
} = require('../src/core');

// Oct 1, 2026 is a Thursday. Oct 4, 2026 is a Sunday.
const START = '2026-10-01';

function rule(extra) {
  return { startDate: START, ...extra };
}

// ---- Scenario 12: weekly rules ---------------------------------------------------------------
test('12. Every 3 weeks on Sunday and Thursday, counted from the start date', () => {
  const r = rule({ frequency: 'weekly', interval: 3, weekdays: [0, 4] });
  assert.deepEqual(generateDates(r, START, '2026-12-31'), [
    '2026-10-01', // Thu, week 0 (the Sunday before the start date is not included)
    '2026-10-18', '2026-10-22', // week 3
    '2026-11-08', '2026-11-12', // week 6
    '2026-11-29', '2026-12-03', // week 9
    '2026-12-20', '2026-12-24', // week 12
  ]);
});

test('12b. Asking for a later window gives the same dates (skip-ahead is safe)', () => {
  const r = rule({ frequency: 'weekly', interval: 3, weekdays: [0, 4] });
  assert.deepEqual(generateDates(r, '2026-11-01', '2026-11-30'), [
    '2026-11-08', '2026-11-12', '2026-11-29',
  ]);
  // A window that starts in a "skipped" week
  assert.deepEqual(generateDates(r, '2026-10-25', '2026-11-07'), []);
});

test('12c. Other weekly patterns', () => {
  assert.deepEqual(
    generateDates(rule({ frequency: 'weekly', interval: 1, weekdays: [5] }), START, '2026-10-24'),
    ['2026-10-02', '2026-10-09', '2026-10-16', '2026-10-23']
  );
  assert.deepEqual(
    generateDates(rule({ frequency: 'weekly', interval: 1, weekdays: [1, 3] }), START, '2026-10-14'),
    ['2026-10-05', '2026-10-07', '2026-10-12', '2026-10-14']
  );
  assert.deepEqual(
    generateDates(rule({ frequency: 'weekly', interval: 1, weekdays: [5, 6] }), START, '2026-10-11'),
    ['2026-10-02', '2026-10-03', '2026-10-09', '2026-10-10']
  );
  assert.deepEqual(
    generateDates(rule({ frequency: 'weekly', interval: 2, weekdays: [5] }), START, '2026-10-31'),
    ['2026-10-02', '2026-10-16', '2026-10-30']
  );
});

test('12d. Weekly with no weekdays chosen repeats on the start date weekday', () => {
  const r = rule({ frequency: 'weekly', interval: 1 });
  assert.deepEqual(normalizeRule(r).weekdays, [4]); // Thursday
  assert.deepEqual(generateDates(r, START, '2026-10-15'), ['2026-10-01', '2026-10-08', '2026-10-15']);
});

test('12e. Daily rules with an interval', () => {
  assert.deepEqual(
    generateDates(rule({ frequency: 'daily', interval: 3 }), START, '2026-10-10'),
    ['2026-10-01', '2026-10-04', '2026-10-07', '2026-10-10']
  );
  assert.deepEqual(
    generateDates(rule({ frequency: 'daily', interval: 3 }), '2026-10-05', '2026-10-10'),
    ['2026-10-07', '2026-10-10']
  );
});

// ---- Scenario 13: monthly rules -----------------------------------------------------------------
test('13. 1st and 3rd Friday of every 2 months', () => {
  const r = rule({
    frequency: 'monthly',
    interval: 2,
    monthly: { type: 'nthWeekday', weekday: 5, positions: [1, 3] },
  });
  assert.deepEqual(generateDates(r, START, '2027-02-28'), [
    '2026-10-02', '2026-10-16',
    '2026-12-04', '2026-12-18',
    '2027-02-05', '2027-02-19',
  ]);
});

test('13b. Last Sunday of every month', () => {
  const r = rule({
    frequency: 'monthly',
    interval: 1,
    monthly: { type: 'nthWeekday', weekday: 0, positions: [-1] },
  });
  assert.deepEqual(generateDates(r, START, '2026-12-31'), ['2026-10-25', '2026-11-29', '2026-12-27']);
});

test('13c. Day 31 monthly falls back to the last day of shorter months', () => {
  const r = rule({ frequency: 'monthly', interval: 1, monthly: { type: 'dayOfMonth', days: [31] } });
  assert.deepEqual(generateDates(r, START, '2027-04-30'), [
    '2026-10-31', '2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30',
  ]);
  // Leap year
  assert.deepEqual(
    generateDates(r, '2028-02-01', '2028-02-29'),
    ['2028-02-29']
  );
});

test('13d. Several day numbers, and no duplicates when they collapse to the same last day', () => {
  const r = rule({ frequency: 'monthly', interval: 1, monthly: { type: 'dayOfMonth', days: [1, 15] } });
  assert.deepEqual(generateDates(r, START, '2026-11-30'), ['2026-10-01', '2026-10-15', '2026-11-01', '2026-11-15']);

  const r2 = rule({ frequency: 'monthly', interval: 1, monthly: { type: 'dayOfMonth', days: [30, 31] } });
  assert.deepEqual(generateDates(r2, '2027-02-01', '2027-02-28'), ['2027-02-28']);
});

test('13e. Last day of the month and last working day (Sun-Thu by default)', () => {
  const lastDay = rule({ frequency: 'monthly', interval: 1, monthly: { type: 'lastDay' } });
  assert.deepEqual(generateDates(lastDay, START, '2026-11-30'), ['2026-10-31', '2026-11-30']);

  const lastWorking = rule({ frequency: 'monthly', interval: 1, monthly: { type: 'lastWorkingDay' } });
  // Oct 31, 2026 is a Saturday -> Thursday Oct 29. Nov 30 is Monday. Dec 31 is Thursday.
  assert.deepEqual(generateDates(lastWorking, START, '2026-12-31'), ['2026-10-29', '2026-11-30', '2026-12-31']);
  // Mon-Fri working week -> Friday Oct 30
  assert.deepEqual(
    generateDates(lastWorking, START, '2026-12-31', { workingDays: [1, 2, 3, 4, 5] }),
    ['2026-10-30', '2026-11-30', '2026-12-31']
  );
});

test('13f. Every Friday of every 2nd month', () => {
  const r = rule({
    frequency: 'monthly',
    interval: 2,
    monthly: { type: 'weekdaysInMonth', weekdays: [5] },
  });
  assert.deepEqual(generateDates(r, START, '2026-12-10'), [
    '2026-10-02', '2026-10-09', '2026-10-16', '2026-10-23', '2026-10-30',
    '2026-12-04',
  ]);
});

test('13g. Yearly rules', () => {
  const fixedDay = rule({ frequency: 'yearly', interval: 1, yearly: { month: 3, type: 'dayOfMonth', day: 15 } });
  // March 15 2026 is before the start date, so the first one is in 2027
  assert.deepEqual(generateDates(fixedDay, START, '2029-12-31'), ['2027-03-15', '2028-03-15', '2029-03-15']);

  const leapDay = rule({ frequency: 'yearly', interval: 1, yearly: { month: 2, type: 'dayOfMonth', day: 29 } });
  assert.deepEqual(generateDates(leapDay, START, '2028-12-31'), ['2027-02-28', '2028-02-29']);

  const nth = rule({
    frequency: 'yearly',
    interval: 1,
    yearly: { month: 11, type: 'nthWeekday', weekday: 5, positions: [2] },
  });
  assert.deepEqual(generateDates(nth, START, '2027-12-31'), ['2026-11-13', '2027-11-12']);

  const everyTwo = rule({ frequency: 'yearly', interval: 2, yearly: { month: 3, type: 'dayOfMonth', day: 15 } });
  assert.deepEqual(generateDates(everyTwo, START, '2031-12-31'), ['2028-03-15', '2030-03-15']);
});

test('13h. Yearly with no details repeats on the start date', () => {
  const r = rule({ frequency: 'yearly', interval: 1 });
  assert.deepEqual(generateDates(r, START, '2028-12-31'), ['2026-10-01', '2027-10-01', '2028-10-01']);
});

// ---- Scenario 14: limits ---------------------------------------------------------------------------
test('14. Every Monday for 20 occurrences stops after exactly 20', () => {
  const r = rule({ frequency: 'weekly', interval: 1, weekdays: [1], end: { type: 'count', count: 20 } });
  const all = generateDates(r, START, '2035-01-01');
  assert.equal(all.length, 20);
  assert.equal(all[0], '2026-10-05');
  assert.equal(all[19], '2027-02-15');

  // A later window still respects the total of 20, counted from the start
  assert.deepEqual(generateDates(r, '2027-01-01', '2035-01-01'), [
    '2027-01-04', '2027-01-11', '2027-01-18', '2027-01-25', '2027-02-01', '2027-02-08', '2027-02-15',
  ]);
});

test('14b. Every Friday from Oct 1 until Dec 31 stops after Dec 31 (end date is inclusive)', () => {
  const fridays = rule({ frequency: 'weekly', interval: 1, weekdays: [5], end: { type: 'date', date: '2026-12-31' } });
  const all = generateDates(fridays, START, '2030-01-01');
  assert.equal(all[0], '2026-10-02');
  assert.equal(all[all.length - 1], '2026-12-25');
  assert.ok(all.every((d) => d <= '2026-12-31'));

  // Dec 31, 2026 is a Thursday, so a Thursday rule includes it
  const thursdays = rule({ frequency: 'weekly', interval: 1, weekdays: [4], end: { type: 'date', date: '2026-12-31' } });
  const th = generateDates(thursdays, START, '2030-01-01');
  assert.equal(th[th.length - 1], '2026-12-31');
});

test('14c. No end continues indefinitely', () => {
  const r = rule({ frequency: 'weekly', interval: 1, weekdays: [5], end: { type: 'never' } });
  const far = generateDates(r, '2040-01-01', '2040-01-31');
  assert.ok(far.length >= 4);
  assert.ok(far.every((d) => d.startsWith('2040-01')));
});

test('14d. Count rules combined with monthly patterns', () => {
  const r = rule({
    frequency: 'monthly',
    interval: 1,
    monthly: { type: 'dayOfMonth', days: [1, 15] },
    end: { type: 'count', count: 5 },
  });
  assert.deepEqual(generateDates(r, START, '2030-01-01'), [
    '2026-10-01', '2026-10-15', '2026-11-01', '2026-11-15', '2026-12-01',
  ]);
});

// ---- Validation, preview and summary ----------------------------------------------------------------
test('Validation catches bad rules with friendly messages', () => {
  assert.ok(validateRule(rule({ frequency: 'weekly', interval: 0, weekdays: [1] })).length > 0);
  assert.ok(validateRule(rule({ frequency: 'weekly', interval: 1, weekdays: [9] })).length > 0);
  assert.ok(validateRule(rule({ frequency: 'sometimes', interval: 1 })).length > 0);
  assert.ok(validateRule({ startDate: 'nope', frequency: 'daily', interval: 1 }).length > 0);
  assert.ok(
    validateRule(rule({ frequency: 'monthly', interval: 1, monthly: { type: 'nthWeekday', weekday: 5, positions: [5] } }))
      .length > 0
  );
  assert.ok(
    validateRule(rule({ frequency: 'daily', interval: 1, end: { type: 'date', date: '2026-09-01' } })).length > 0,
    'end before start'
  );
  assert.ok(validateRule(rule({ frequency: 'daily', interval: 1, end: { type: 'count', count: 0 } })).length > 0);
  assert.ok(
    validateRule(rule({ frequency: 'yearly', interval: 1, yearly: { month: 4, type: 'dayOfMonth', day: 31 } })).length > 0,
    'April has no 31st'
  );
  assert.deepEqual(validateRule(rule({ frequency: 'daily', interval: 2 })), []);
  assert.throws(() => generateDates(rule({ frequency: 'weekly', interval: 0, weekdays: [1] }), START, '2026-12-31'));
});

test('Preview gives the next few occurrences', () => {
  const r = rule({ frequency: 'weekly', interval: 2, weekdays: [1, 3, 5] });
  const preview = previewDates(r, 5);
  assert.equal(preview.length, 5);
  // Week of Oct 4-10 is skipped (every 2 weeks, counted from the week containing Oct 1)
  assert.deepEqual(preview, ['2026-10-02', '2026-10-12', '2026-10-14', '2026-10-16', '2026-10-26']);

  // Preview starting later in time
  const later = previewDates(r, 2, { fromKey: '2026-11-01' });
  assert.equal(later.length, 2);
  assert.ok(later.every((d) => d >= '2026-11-01'));

  // A rule with only 3 occurrences previews only 3
  const short = rule({ frequency: 'daily', interval: 1, end: { type: 'count', count: 3 } });
  assert.equal(previewDates(short, 5).length, 3);
});

test('Plain-language summaries', () => {
  assert.equal(
    describeRule(rule({ frequency: 'weekly', interval: 2, weekdays: [1, 3, 5], end: { type: 'date', date: '2026-12-31' } })),
    'Every 2 weeks on Mon, Wed, Fri, starting Oct 1, until Dec 31'
  );
  assert.equal(describeRule(rule({ frequency: 'weekly', interval: 1, weekdays: [5] })), 'Every Friday, starting Oct 1');
  assert.equal(describeRule(rule({ frequency: 'daily', interval: 1 })), 'Every day, starting Oct 1');
  assert.equal(
    describeRule(rule({ frequency: 'weekly', interval: 1, weekdays: [1], end: { type: 'count', count: 20 } })),
    'Every Monday, starting Oct 1, for 20 occurrences'
  );
  assert.equal(
    describeRule(
      rule({ frequency: 'monthly', interval: 2, monthly: { type: 'nthWeekday', weekday: 5, positions: [1, 3] } })
    ),
    'Every 2 months on the 1st and 3rd Friday, starting Oct 1'
  );
  assert.equal(
    describeRule(rule({ frequency: 'monthly', interval: 1, monthly: { type: 'nthWeekday', weekday: 0, positions: [-1] } })),
    'Every month on the last Sunday, starting Oct 1'
  );
  assert.equal(
    describeRule(rule({ frequency: 'monthly', interval: 1, monthly: { type: 'lastWorkingDay' } })),
    'Every month on the last working day, starting Oct 1'
  );
  assert.equal(
    describeRule(rule({ frequency: 'monthly', interval: 1, monthly: { type: 'dayOfMonth', days: [1, 15] } })),
    'Every month on day 1 and 15, starting Oct 1'
  );
  assert.equal(
    describeRule(rule({ frequency: 'monthly', interval: 2, monthly: { type: 'weekdaysInMonth', weekdays: [5] } })),
    'Every Friday of every 2nd month, starting Oct 1'
  );
  assert.equal(
    describeRule(rule({ frequency: 'yearly', interval: 1, yearly: { month: 3, type: 'dayOfMonth', day: 15 }, end: { type: 'date', date: '2030-01-01' } })),
    'Every year on March 15, starting Oct 1, until Jan 1, 2030'
  );
});
