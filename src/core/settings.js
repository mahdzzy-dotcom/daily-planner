'use strict';

// Application settings (spec 12.4): defaults and validation.
// Reminder-related settings share their names with DEFAULT_REMINDER_SETTINGS.

const { CITIES, DEFAULT_CITY } = require('./cities');
const { PRAYERS } = require('./zones');
const { DEFAULT_REMINDER_SETTINGS } = require('./reminders');

const METHOD_KEYS = [
  'egyptian',
  'muslimWorldLeague',
  'karachi',
  'ummAlQura',
  'dubai',
  'qatar',
  'kuwait',
  'singapore',
  'turkey',
  'tehran',
  'northAmerica',
  'moonsightingCommittee',
];

const METHOD_LABELS = {
  egyptian: 'Egyptian General Authority of Survey',
  muslimWorldLeague: 'Muslim World League',
  karachi: 'University of Islamic Sciences, Karachi',
  ummAlQura: 'Umm al-Qura University, Makkah',
  dubai: 'Dubai',
  qatar: 'Qatar',
  kuwait: 'Kuwait',
  singapore: 'Singapore',
  turkey: 'Turkey (Diyanet)',
  tehran: 'Institute of Geophysics, Tehran',
  northAmerica: 'Islamic Society of North America',
  moonsightingCommittee: 'Moonsighting Committee',
};

const THEMES = ['light', 'dark', 'system'];

const DEFAULT_SETTINGS = {
  ...DEFAULT_REMINDER_SETTINGS,
  // Prayer times
  cityName: DEFAULT_CITY,
  method: 'egyptian',
  adjustments: { fajr: 0, dhuhr: 0, asr: 0, maghrib: 0, isha: 0 },
  hijriAdjustment: 0, // -1, 0 or +1 day
  // Application
  startWithWindows: false,
  showBackgroundMessage: true, // the "still running in the background" message on first close
  backgroundMessageShown: false,
  theme: 'system',
  workingDays: [0, 1, 2, 3, 4], // Sunday - Thursday
};

function isWholeNumber(n, min, max) {
  return Number.isInteger(n) && n >= min && n <= max;
}

// Checks a (possibly partial) settings object. Returns a list of friendly messages.
function validateSettings(settings) {
  const errors = [];
  const s = settings;
  if ('cityName' in s && !CITIES.some((c) => c.name === s.cityName)) errors.push('Please choose a city from the list');
  if ('method' in s && !METHOD_KEYS.includes(s.method)) errors.push('Please choose a calculation method from the list');
  if ('adjustments' in s) {
    for (const prayer of PRAYERS) {
      if (s.adjustments && prayer in s.adjustments && !isWholeNumber(s.adjustments[prayer], -120, 120)) {
        errors.push(`The ${prayer} adjustment must be a whole number of minutes between -120 and 120`);
      }
    }
  }
  if ('hijriAdjustment' in s && ![-1, 0, 1].includes(s.hijriAdjustment)) errors.push('Hijri adjustment must be -1, 0 or +1');
  if ('theme' in s && !THEMES.includes(s.theme)) errors.push('Theme must be Light, Dark or System');
  if ('defaultReminderOffsetMinutes' in s && !isWholeNumber(s.defaultReminderOffsetMinutes, 0, 10080)) {
    errors.push('Default reminder time must be a whole number of minutes (0 or more)');
  }
  if ('snoozeMinutes' in s && !isWholeNumber(s.snoozeMinutes, 1, 1440)) {
    errors.push('Snooze time must be a whole number of minutes (1 or more)');
  }
  if ('workingDays' in s) {
    if (!Array.isArray(s.workingDays) || s.workingDays.length === 0 || !s.workingDays.every((d) => isWholeNumber(d, 0, 6))) {
      errors.push('Choose at least one working day');
    }
  }
  for (const key of ['notificationsEnabled', 'soundEnabled', 'zoneStartNotifications', 'startWithWindows', 'showBackgroundMessage', 'backgroundMessageShown']) {
    if (key in s && typeof s[key] !== 'boolean') errors.push(`${key} must be on or off`);
  }
  return errors;
}

// Merge a partial update into settings (adjustments merge per prayer). Throws on invalid input.
function mergeSettings(current, patch) {
  const errors = validateSettings(patch);
  if (errors.length) throw new Error(errors.join('; '));
  const merged = { ...current, ...patch };
  merged.adjustments = { ...current.adjustments, ...(patch.adjustments || {}) };
  if (patch.workingDays) merged.workingDays = Array.from(new Set(patch.workingDays)).sort((a, b) => a - b);
  return merged;
}

// For loading saved or imported data: keep only known, valid values; fill the rest with defaults.
function sanitizeSettings(raw) {
  const clean = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  if (!raw || typeof raw !== 'object') return clean;
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (!(key in raw)) continue;
    const candidate = key === 'adjustments' ? { adjustments: { ...clean.adjustments, ...raw.adjustments } } : { [key]: raw[key] };
    if (validateSettings(candidate).length === 0) {
      if (key === 'adjustments') clean.adjustments = candidate.adjustments;
      else clean[key] = raw[key];
    }
  }
  return clean;
}

module.exports = {
  METHOD_KEYS,
  METHOD_LABELS,
  THEMES,
  DEFAULT_SETTINGS,
  validateSettings,
  mergeSettings,
  sanitizeSettings,
};
