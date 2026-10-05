'use strict';

// Fixed prayer times for tests (the example from the spec, Section 16).
// Times are 24-hour "HH:MM" strings in LOCAL time.

const { parseDateKey } = require('../src/core/time');

function at(dateKeyString, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = parseDateKey(dateKeyString);
  d.setHours(h, m, 0, 0);
  return d;
}

// Like at(), but also accepts seconds: atS('2026-10-04', '08:50:45')
function atS(dateKeyString, hhmmss) {
  const [h, m, sec] = hhmmss.split(':').map(Number);
  const d = parseDateKey(dateKeyString);
  d.setHours(h, m, sec || 0, 0);
  return d;
}

function day(key, fajr, dhuhr, asr, maghrib, isha) {
  return {
    fajr: at(key, fajr),
    dhuhr: at(key, dhuhr),
    asr: at(key, asr),
    maghrib: at(key, maghrib),
    isha: at(key, isha),
  };
}

const TABLE = {
  // Spec example day and its neighbours
  '2026-10-03': day('2026-10-03', '05:04', '11:48', '15:15', '18:01', '19:21'),
  '2026-10-04': day('2026-10-04', '05:05', '11:48', '15:14', '18:00', '19:20'),
  '2026-10-05': day('2026-10-05', '05:06', '11:47', '15:12', '17:58', '19:18'),
  '2026-10-06': day('2026-10-06', '05:07', '11:47', '15:11', '17:57', '19:17'),
  // "Winter-like" day: Fajr at 5:00 AM (scenario 11)
  '2026-01-15': day('2026-01-15', '05:00', '12:00', '15:00', '17:30', '18:50'),
  '2026-01-16': day('2026-01-16', '05:00', '12:00', '15:01', '17:31', '18:51'),
  // "Summer-like" day: Fajr at 5:25 AM (scenario 11)
  '2026-07-14': day('2026-07-14', '05:24', '12:00', '15:40', '19:00', '20:30'),
  '2026-07-15': day('2026-07-15', '05:25', '12:00', '15:40', '19:00', '20:30'),
  '2026-07-16': day('2026-07-16', '05:26', '12:00', '15:40', '19:00', '20:30'),
};

// Fill the gaps around the example days with plausible times, so tests that look a few days
// ahead or behind do not fail just because a date is missing from the table above.
(function fillAutumnDays() {
  const { addDaysToKey } = require('../src/core/time');
  for (let key = '2026-09-25'; key <= '2026-10-25'; key = addDaysToKey(key, 1)) {
    if (!TABLE[key]) TABLE[key] = day(key, '05:08', '11:46', '15:10', '17:55', '19:15');
  }
})();

function provider(key) {
  const t = TABLE[key];
  if (!t) throw new Error(`Test provider has no times for ${key}`);
  return t;
}

// Same prayer times every day. Handy for tests that span many dates.
function constantProvider(key) {
  return day(key, '05:05', '11:48', '15:14', '18:00', '19:20');
}

module.exports = { at, atS, provider, constantProvider };
