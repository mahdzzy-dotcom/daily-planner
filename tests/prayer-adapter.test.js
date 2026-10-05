'use strict';

// These tests check the real prayer-time library (adhan) with sanity checks.
// They are skipped automatically when the library is not installed.
// On GitHub the library IS installed, so they run there.

const test = require('node:test');
const assert = require('node:assert/strict');

let adhanAvailable = true;
try {
  require.resolve('adhan');
} catch (e) {
  adhanAvailable = false;
}

const { createPrayerProvider } = adhanAvailable ? require('../src/core/prayer-adapter') : {};
const { CITIES, findCity, DEFAULT_CITY } = require('../src/core/cities');
const { deriveZone, getBoundaries, getZones, PRAYERS } = require('../src/core');

// Hour and minute of a moment as seen on a clock in Cairo, so these checks give
// the same answer no matter which time zone the test computer is set to.
function cairoClock(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Cairo',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === 'hour').value);
  const m = Number(parts.find((p) => p.type === 'minute').value);
  return h + m / 60;
}

const cairo = findCity(DEFAULT_CITY);

test('City list has all expected cities and Cairo as default', () => {
  assert.equal(DEFAULT_CITY, 'Cairo');
  assert.ok(CITIES.length >= 28);
  for (const city of CITIES) {
    assert.ok(city.latitude > 21 && city.latitude < 32, `${city.name} latitude`);
    assert.ok(city.longitude > 24 && city.longitude < 37, `${city.name} longitude`);
  }
});

test('Cairo times fall in sensible clock ranges all year', { skip: !adhanAvailable }, () => {
  const provider = createPrayerProvider({
    latitude: cairo.latitude,
    longitude: cairo.longitude,
    method: 'egyptian',
  });
  const dates = ['2026-01-15', '2026-04-15', '2026-07-15', '2026-10-04', '2026-12-20'];
  for (const key of dates) {
    const t = provider(key);
    const clock = Object.fromEntries(PRAYERS.map((p) => [p, cairoClock(t[p])]));
    assert.ok(clock.fajr > 3 && clock.fajr < 6.5, `${key} fajr ${clock.fajr}`);
    assert.ok(clock.dhuhr > 11 && clock.dhuhr < 13.5, `${key} dhuhr ${clock.dhuhr}`);
    assert.ok(clock.asr > 14 && clock.asr < 17.5, `${key} asr ${clock.asr}`);
    assert.ok(clock.maghrib > 16.5 && clock.maghrib < 20, `${key} maghrib ${clock.maghrib}`);
    assert.ok(clock.isha > 18 && clock.isha < 21.5, `${key} isha ${clock.isha}`);
    // Strictly increasing through the day
    for (let i = 1; i < PRAYERS.length; i++) {
      assert.ok(t[PRAYERS[i]] > t[PRAYERS[i - 1]], `${key} order ${PRAYERS[i]}`);
    }
  }
});

test('Times are whole minutes (no seconds)', { skip: !adhanAvailable }, () => {
  const provider = createPrayerProvider({ latitude: cairo.latitude, longitude: cairo.longitude });
  const t = provider('2026-10-04');
  for (const p of PRAYERS) {
    assert.equal(t[p].getSeconds(), 0);
    assert.equal(t[p].getMilliseconds(), 0);
  }
});

test('Per-prayer adjustment shifts only that prayer by the given minutes', { skip: !adhanAvailable }, () => {
  const base = createPrayerProvider({ latitude: cairo.latitude, longitude: cairo.longitude });
  const shifted = createPrayerProvider({
    latitude: cairo.latitude,
    longitude: cairo.longitude,
    adjustments: { asr: 7, fajr: -3 },
  });
  const a = base('2026-10-04');
  const b = shifted('2026-10-04');
  assert.equal(b.asr - a.asr, 7 * 60000);
  assert.equal(b.fajr - a.fajr, -3 * 60000);
  assert.equal(b.dhuhr - a.dhuhr, 0);
  assert.equal(b.maghrib - a.maghrib, 0);
  assert.equal(b.isha - a.isha, 0);
});

test('Zones built from real times cover a full Planning Day in order', { skip: !adhanAvailable }, () => {
  const provider = createPrayerProvider({ latitude: cairo.latitude, longitude: cairo.longitude });
  const zones = getZones(getBoundaries(provider, '2026-10-04'));
  assert.equal(zones.length, 5);
  for (const z of zones) assert.ok(z.totalMinutes > 0, `${z.name} has positive length`);
  const total = zones.reduce((s, z) => s + z.totalMinutes, 0);
  assert.ok(total > 23 * 60 && total < 25 * 60, `total ${total}`);

  // A moment in the middle of Zone 2 derives to Zone 2
  const mid = new Date((zones[1].start.getTime() + zones[1].end.getTime()) / 2);
  assert.equal(deriveZone(provider, mid).zoneIndex, 2);
});

test('Every listed method name works', { skip: !adhanAvailable }, () => {
  const { METHODS } = require('../src/core/prayer-adapter');
  for (const method of Object.keys(METHODS)) {
    const provider = createPrayerProvider({
      latitude: cairo.latitude,
      longitude: cairo.longitude,
      method,
    });
    const t = provider('2026-10-04');
    assert.ok(t.fajr < t.dhuhr, `${method} produced times`);
  }
});

test('Unknown method is rejected', { skip: !adhanAvailable }, () => {
  assert.throws(() =>
    createPrayerProvider({ latitude: 30, longitude: 31, method: 'nonsense' })
  );
});
