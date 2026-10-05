'use strict';

// Connects the "adhan" prayer-time library to the zone engine.
// Everything else in src/core works with any provider function, so this is the
// only file that knows about the library.

const { parseDateKey } = require('./time');
const { PRAYERS } = require('./zones');

// Settings name -> adhan method name
const METHODS = {
  egyptian: 'Egyptian', // DEFAULT: Egyptian General Authority of Survey
  muslimWorldLeague: 'MuslimWorldLeague',
  karachi: 'Karachi',
  ummAlQura: 'UmmAlQura',
  dubai: 'Dubai',
  qatar: 'Qatar',
  kuwait: 'Kuwait',
  singapore: 'Singapore',
  turkey: 'Turkey',
  tehran: 'Tehran',
  northAmerica: 'NorthAmerica',
  moonsightingCommittee: 'MoonsightingCommittee',
};

function roundToMinute(date) {
  return new Date(Math.round(date.getTime() / 60000) * 60000);
}

// options: { latitude, longitude, method, adjustments: { fajr: 0, dhuhr: 0, ... } }
// Returns a provider: (dateKey) => { fajr, dhuhr, asr, maghrib, isha } (Dates, minute precision).
// When the user changes city / method / adjustments, create a NEW provider.
function createPrayerProvider(options) {
  const adhan = require('adhan');
  const { latitude, longitude, method = 'egyptian', adjustments = {} } = options;

  const methodName = METHODS[method];
  if (!methodName) throw new Error(`Unknown calculation method: ${method}`);

  const params = adhan.CalculationMethod[methodName]();
  params.madhab = adhan.Madhab.Shafi; // standard Asr calculation
  for (const prayer of PRAYERS) {
    if (typeof adjustments[prayer] === 'number') {
      params.adjustments[prayer] = adjustments[prayer];
    }
  }

  const coordinates = new adhan.Coordinates(latitude, longitude);
  const cache = new Map();

  return function provider(key) {
    if (cache.has(key)) return cache.get(key);
    const times = new adhan.PrayerTimes(coordinates, parseDateKey(key), params);
    const result = {
      fajr: roundToMinute(times.fajr),
      dhuhr: roundToMinute(times.dhuhr),
      asr: roundToMinute(times.asr),
      maghrib: roundToMinute(times.maghrib),
      isha: roundToMinute(times.isha),
    };
    cache.set(key, result);
    return result;
  };
}

module.exports = { METHODS, createPrayerProvider };
