'use strict';

// Scenario 24: daylight saving changes. The app works out every time from local clock times on
// each tick, so a change in the PC's UTC offset is picked up automatically. These tests run the
// logic in a separate process set to Egypt's time zone, around the real 2026 changes.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

function runInEgypt() {
  const run = spawnSync(process.execPath, [path.join(__dirname, 'dst-child.js')], {
    env: { ...process.env, TZ: 'Africa/Cairo' },
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

const result = runInEgypt();
const skip = result.hasDst ? false : 'this computer\'s time zone data has no Egyptian daylight saving time';

test('24. A daily 9:00 AM task stays at 9:00 AM across the clocks going back (the day is 25 hours long)', { skip }, () => {
  assert.deepEqual(result.fallBack.map((o) => [o.date, o.start]), [
    ['2026-10-28', '9:00 AM'], ['2026-10-29', '9:00 AM'], ['2026-10-30', '9:00 AM'], ['2026-10-31', '9:00 AM'],
  ]);
  assert.deepEqual(result.fallBack.map((o) => o.realMinutesToNext), [1440, 1500, 1440, null]);
});

test('24b. Zone 5 is an hour longer on the night the clocks go back, and an hour shorter when they go forward', { skip }, () => {
  assert.equal(result.zone5.normal, 585); // 7:20 PM to 5:05 AM = 9h 45m
  assert.equal(result.zone5.fallBack, 645);
  assert.equal(result.zone5.springForward, 525);
});

test('24c. End time is start plus duration in real minutes', { skip }, () => {
  assert.equal(result.late.realMinutes, 90);
  // 11:30 PM + 90 real minutes: the clocks go back at midnight, so the wall clock shows 12:00 AM, not 1:00 AM
  assert.equal(result.late.end, '12:00 AM');
});

test('24d. A clock time that happens twice (the repeated hour) notifies only once', { skip }, () => {
  assert.equal(result.repeatedHourNotifications, 1);
});

test('24e. The day the clocks go forward still has a normal 9:00 AM start', { skip }, () => {
  assert.deepEqual(result.springForward, { start: '9:00 AM', hour: 9 });
});
