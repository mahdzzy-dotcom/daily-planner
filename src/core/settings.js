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

// ---- Full-screen reminder appearance -------------------------------------------------------------------------

const ALERT_FONTS = ['Segoe UI', 'Tahoma', 'Arial', 'Verdana', 'Georgia', 'Times New Roman'];
const ALERT_SCREENS = ['all', 'main'];

const isColor = (v) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
const isBool = (v) => typeof v === 'boolean';
const intBetween = (min, max) => (v) => Number.isInteger(v) && v >= min && v <= max;
const oneOf = (list) => (v) => list.includes(v);

// Each entry: a check, or a group of entries. Used for validating, merging and cleaning.
const APPEARANCE_SCHEMA = {
  backgroundColor: isColor,
  textColor: isColor, // the details line and the labels
  accentColor: isColor, // the "STARTS NOW" label and the main button
  fontFamily: oneOf(ALERT_FONTS),
  alignment: oneOf(['left', 'center']),
  name: { size: intBetween(24, 160), color: isColor, bold: isBool, italic: isBool, uppercase: isBool },
  notes: { show: isBool, size: intBetween(14, 96), color: isColor, bold: isBool, italic: isBool },
  show: { time: isBool, duration: isBool, zone: isBool, category: isBool, priority: isBool },
};

const DEFAULT_ALERT_APPEARANCE = {
  backgroundColor: '#0f172a',
  textColor: '#e2e8f0',
  accentColor: '#fbbf24',
  fontFamily: 'Segoe UI',
  alignment: 'center',
  name: { size: 80, color: '#ffffff', bold: true, italic: false, uppercase: false },
  notes: { show: true, size: 34, color: '#cbd5e1', bold: false, italic: false },
  show: { time: true, duration: true, zone: true, category: true, priority: true },
};

// Ready-made looks (each one is a complete appearance).
const ALERT_PRESETS = {
  dark: { label: 'Dark', appearance: DEFAULT_ALERT_APPEARANCE },
  light: {
    label: 'Light',
    appearance: {
      ...DEFAULT_ALERT_APPEARANCE,
      backgroundColor: '#ffffff', textColor: '#1f2937', accentColor: '#2563eb',
      name: { ...DEFAULT_ALERT_APPEARANCE.name, color: '#111827' },
      notes: { ...DEFAULT_ALERT_APPEARANCE.notes, color: '#374151' },
    },
  },
  highContrast: {
    label: 'High contrast',
    appearance: {
      ...DEFAULT_ALERT_APPEARANCE,
      backgroundColor: '#000000', textColor: '#ffffff', accentColor: '#ffff00',
      name: { size: 96, color: '#ffff00', bold: true, italic: false, uppercase: true },
      notes: { ...DEFAULT_ALERT_APPEARANCE.notes, size: 40, color: '#ffffff' },
    },
  },
  red: {
    label: 'Red alert',
    appearance: {
      ...DEFAULT_ALERT_APPEARANCE,
      backgroundColor: '#7f1d1d', textColor: '#fee2e2', accentColor: '#fde047',
      name: { ...DEFAULT_ALERT_APPEARANCE.name, size: 88, color: '#ffffff' },
      notes: { ...DEFAULT_ALERT_APPEARANCE.notes, color: '#fecaca' },
    },
  },
  calm: {
    label: 'Calm green',
    appearance: {
      ...DEFAULT_ALERT_APPEARANCE,
      backgroundColor: '#064e3b', textColor: '#d1fae5', accentColor: '#fcd34d',
      name: { ...DEFAULT_ALERT_APPEARANCE.name, color: '#ecfdf5' },
      notes: { ...DEFAULT_ALERT_APPEARANCE.notes, color: '#a7f3d0' },
    },
  },
};

// Friendly messages for anything in a (possibly partial) appearance that is not valid.
function validateAppearance(value, schema = APPEARANCE_SCHEMA, label = 'Appearance') {
  const errors = [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [`${label} is not valid`];
  for (const key of Object.keys(value)) {
    const rule = schema[key];
    if (rule === undefined) {
      errors.push(`${label}: unknown option "${key}"`);
    } else if (typeof rule === 'function') {
      if (!rule(value[key])) errors.push(`${label}: "${key}" is not a valid value`);
    } else {
      errors.push(...validateAppearance(value[key], rule, `${label} ${key}`));
    }
  }
  return errors;
}

// current + patch, one level at a time (only the fields in the patch change).
function mergeAppearance(current, patch) {
  const out = JSON.parse(JSON.stringify(current));
  for (const key of Object.keys(patch)) {
    if (patch[key] !== null && typeof patch[key] === 'object') out[key] = mergeAppearance(out[key] || {}, patch[key]);
    else out[key] = patch[key];
  }
  return out;
}

// Keep only valid values; use the default for everything else.
function sanitizeAppearance(raw, schema = APPEARANCE_SCHEMA, defaults = DEFAULT_ALERT_APPEARANCE) {
  const out = {};
  for (const key of Object.keys(schema)) {
    const rule = schema[key];
    const candidate = raw && typeof raw === 'object' ? raw[key] : undefined;
    if (typeof rule === 'function') out[key] = candidate !== undefined && rule(candidate) ? candidate : defaults[key];
    else out[key] = sanitizeAppearance(candidate, rule, defaults[key]);
  }
  return out;
}

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
  welcomeShown: false, // the first-run "choose your city" screen
  theme: 'system',
  workingDays: [0, 1, 2, 3, 4], // Sunday - Thursday
  // Full-screen reminder at the exact start time
  fullScreenAlerts: true, // master switch; each task still has its own switch
  fullScreenDefaultForNewTasks: false,
  alertScreens: 'all', // 'all' screens, or only the 'main' one
  alertAppearance: DEFAULT_ALERT_APPEARANCE,
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
  if ('alertScreens' in s && !ALERT_SCREENS.includes(s.alertScreens)) errors.push('Choose all screens or the main screen');
  if ('alertAppearance' in s) errors.push(...validateAppearance(s.alertAppearance));
  for (const key of ['notificationsEnabled', 'soundEnabled', 'zoneStartNotifications', 'startWithWindows', 'showBackgroundMessage', 'backgroundMessageShown', 'welcomeShown', 'fullScreenAlerts', 'fullScreenDefaultForNewTasks']) {
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
  if (patch.alertAppearance) merged.alertAppearance = mergeAppearance(current.alertAppearance, patch.alertAppearance);
  return merged;
}

// For loading saved or imported data: keep only known, valid values; fill the rest with defaults.
function sanitizeSettings(raw) {
  const clean = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  if (!raw || typeof raw !== 'object') return clean;
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (!(key in raw)) continue;
    if (key === 'alertAppearance') {
      clean.alertAppearance = sanitizeAppearance(raw.alertAppearance);
      continue;
    }
    const candidate = key === 'adjustments' ? { adjustments: { ...clean.adjustments, ...raw.adjustments } } : { [key]: raw[key] };
    if (validateSettings(candidate).length === 0) {
      if (key === 'adjustments') clean.adjustments = candidate.adjustments;
      else clean[key] = raw[key];
    }
  }
  return clean;
}

module.exports = {
  ALERT_FONTS,
  ALERT_SCREENS,
  ALERT_PRESETS,
  DEFAULT_ALERT_APPEARANCE,
  validateAppearance,
  mergeAppearance,
  sanitizeAppearance,
  METHOD_KEYS,
  METHOD_LABELS,
  THEMES,
  DEFAULT_SETTINGS,
  validateSettings,
  mergeSettings,
  sanitizeSettings,
};
