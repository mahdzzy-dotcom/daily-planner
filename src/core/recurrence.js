'use strict';

// Rule-based recurrence engine.
//
// A rule is plain data (see README / spec Section 8). Example:
//   {
//     startDate: '2026-10-01',
//     frequency: 'weekly',            // 'daily' | 'weekly' | 'monthly' | 'yearly'
//     interval: 3,                    // every 3 weeks
//     weekdays: [0, 4],               // 0 = Sunday ... 6 = Saturday
//     end: { type: 'never' }          // or { type:'date', date:'2026-12-31' } / { type:'count', count: 20 }
//   }
//
//   monthly: monthly: { type: 'dayOfMonth', days: [1, 15] }
//            monthly: { type: 'lastDay' }
//            monthly: { type: 'nthWeekday', weekday: 5, positions: [1, 3] }   // positions 1-4, or -1 = last
//            monthly: { type: 'lastWorkingDay' }
//            monthly: { type: 'weekdaysInMonth', weekdays: [5] }              // every Friday of the month
//   yearly:  yearly: { month: 3, type: 'dayOfMonth', day: 15 }
//            yearly: { month: 11, type: 'nthWeekday', weekday: 5, positions: [2] }
//
// The engine only produces calendar DATES (date keys). Times and zones are handled elsewhere.
// New pattern types can be added by extending monthDates() / the frequency handlers below.

const {
  makeKey,
  splitKey,
  keyToDayNumber,
  dayNumberToKey,
  isValidKey,
  weekdayOfKey,
  daysInMonth,
  addDaysToKey,
  formatKeyShort,
} = require('./time');

const FREQUENCIES = ['daily', 'weekly', 'monthly', 'yearly'];
const MONTHLY_TYPES = ['dayOfMonth', 'lastDay', 'nthWeekday', 'lastWorkingDay', 'weekdaysInMonth'];
const YEARLY_TYPES = ['dayOfMonth', 'nthWeekday'];
const VALID_POSITIONS = [1, 2, 3, 4, -1];

const DEFAULT_OPTIONS = {
  workingDays: [0, 1, 2, 3, 4], // Sunday - Thursday (Settings can change this)
  weekStartsOn: 0, // weeks are counted Sunday to Saturday
};

const MAX_PERIODS = 200000; // safety stop

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function uniqueSorted(numbers) {
  return Array.from(new Set(numbers)).sort((a, b) => a - b);
}

// Fill in sensible defaults so every rule is explicit (e.g. weekly with no weekdays
// repeats on the weekday of the start date).
function normalizeRule(rule) {
  const r = clone(rule);
  if (r.interval === undefined || r.interval === null) r.interval = 1;
  if (!r.end) r.end = { type: 'never' };
  if (isValidKey(r.startDate)) {
    const start = splitKey(r.startDate);
    if (r.frequency === 'weekly' && (!Array.isArray(r.weekdays) || r.weekdays.length === 0)) {
      r.weekdays = [weekdayOfKey(r.startDate)];
    }
    if (r.frequency === 'monthly' && !r.monthly) {
      r.monthly = { type: 'dayOfMonth', days: [start.d] };
    }
    if (r.frequency === 'yearly' && !r.yearly) {
      r.yearly = { month: start.m, type: 'dayOfMonth', day: start.d };
    }
  }
  if (Array.isArray(r.weekdays)) r.weekdays = uniqueSorted(r.weekdays);
  if (r.monthly) {
    if (Array.isArray(r.monthly.days)) r.monthly.days = uniqueSorted(r.monthly.days);
    if (Array.isArray(r.monthly.weekdays)) r.monthly.weekdays = uniqueSorted(r.monthly.weekdays);
    if (Array.isArray(r.monthly.positions)) r.monthly.positions = uniqueSorted(r.monthly.positions);
  }
  if (r.yearly && Array.isArray(r.yearly.positions)) {
    r.yearly.positions = uniqueSorted(r.yearly.positions);
  }
  return r;
}

function isWeekday(n) {
  return Number.isInteger(n) && n >= 0 && n <= 6;
}

function checkPositions(positions, label, errors) {
  if (!Array.isArray(positions) || positions.length === 0) {
    errors.push(`${label}: choose at least one position (1st, 2nd, 3rd, 4th or last)`);
  } else if (!positions.every((p) => VALID_POSITIONS.includes(p))) {
    errors.push(`${label}: positions must be 1, 2, 3, 4 or -1 (last)`);
  }
}

// Returns a list of friendly error messages (empty list = valid).
function validateRule(rule) {
  const errors = [];
  if (!rule || typeof rule !== 'object') return ['Recurrence is missing'];
  const r = normalizeRule(rule);

  if (!isValidKey(r.startDate)) errors.push('Start date is not a valid date');
  if (!FREQUENCIES.includes(r.frequency)) errors.push('Repeat must be daily, weekly, monthly or yearly');
  if (!Number.isInteger(r.interval) || r.interval < 1) errors.push('"Every N" must be a whole number, 1 or more');

  if (r.frequency === 'weekly') {
    if (!Array.isArray(r.weekdays) || r.weekdays.length === 0 || !r.weekdays.every(isWeekday)) {
      errors.push('Weekly: choose at least one weekday');
    }
  }

  if (r.frequency === 'monthly') {
    const m = r.monthly;
    if (!m || !MONTHLY_TYPES.includes(m.type)) {
      errors.push('Monthly: choose how the task repeats within the month');
    } else if (m.type === 'dayOfMonth') {
      if (!Array.isArray(m.days) || m.days.length === 0 || !m.days.every((d) => Number.isInteger(d) && d >= 1 && d <= 31)) {
        errors.push('Monthly: day numbers must be between 1 and 31');
      }
    } else if (m.type === 'nthWeekday') {
      if (!isWeekday(m.weekday)) errors.push('Monthly: choose a weekday');
      checkPositions(m.positions, 'Monthly', errors);
    } else if (m.type === 'weekdaysInMonth') {
      if (!Array.isArray(m.weekdays) || m.weekdays.length === 0 || !m.weekdays.every(isWeekday)) {
        errors.push('Monthly: choose at least one weekday');
      }
    }
  }

  if (r.frequency === 'yearly') {
    const y = r.yearly;
    if (!y || !Number.isInteger(y.month) || y.month < 1 || y.month > 12) {
      errors.push('Yearly: choose a month');
    } else if (!YEARLY_TYPES.includes(y.type)) {
      errors.push('Yearly: choose a day of the month or a weekday position');
    } else if (y.type === 'dayOfMonth') {
      const maxDay = daysInMonth(2024, y.month); // leap year, so Feb 29 is allowed
      if (!Number.isInteger(y.day) || y.day < 1 || y.day > maxDay) {
        errors.push('Yearly: that day does not exist in the chosen month');
      }
    } else if (y.type === 'nthWeekday') {
      if (!isWeekday(y.weekday)) errors.push('Yearly: choose a weekday');
      checkPositions(y.positions, 'Yearly', errors);
    }
  }

  const end = r.end;
  if (!end || !['never', 'date', 'count'].includes(end.type)) {
    errors.push('End must be "never", an end date, or a number of occurrences');
  } else if (end.type === 'date') {
    if (!isValidKey(end.date)) errors.push('End date is not a valid date');
    else if (isValidKey(r.startDate) && end.date < r.startDate) errors.push('End date is before the start date');
  } else if (end.type === 'count') {
    if (!Number.isInteger(end.count) || end.count < 1) errors.push('Number of occurrences must be 1 or more');
  }

  return errors;
}

// ---- Dates inside one month -------------------------------------------------------------

function monthDates(year, month, spec, opts) {
  const dim = daysInMonth(year, month);
  const days = [];

  switch (spec.type) {
    case 'dayOfMonth': {
      const wanted = spec.days || [spec.day];
      // Months with fewer days fall back to the LAST day of the month.
      for (const d of wanted) days.push(Math.min(d, dim));
      break;
    }
    case 'lastDay':
      days.push(dim);
      break;
    case 'nthWeekday': {
      const firstWeekday = weekdayOfKey(makeKey(year, month, 1));
      const lastWeekday = weekdayOfKey(makeKey(year, month, dim));
      for (const pos of spec.positions) {
        if (pos > 0) {
          const day = 1 + ((spec.weekday - firstWeekday + 7) % 7) + 7 * (pos - 1);
          if (day <= dim) days.push(day);
        } else {
          days.push(dim - ((lastWeekday - spec.weekday + 7) % 7));
        }
      }
      break;
    }
    case 'weekdaysInMonth':
      for (let d = 1; d <= dim; d++) {
        if (spec.weekdays.includes(weekdayOfKey(makeKey(year, month, d)))) days.push(d);
      }
      break;
    case 'lastWorkingDay':
      for (let d = dim; d >= 1; d--) {
        if (opts.workingDays.includes(weekdayOfKey(makeKey(year, month, d)))) {
          days.push(d);
          break;
        }
      }
      break;
    default:
      throw new Error(`Unknown monthly type: ${spec.type}`);
  }

  return uniqueSorted(days).map((d) => makeKey(year, month, d));
}

// ---- Periods: the repeating "blocks" of time the interval counts in -----------------------
// daily  -> one day        weekly -> one Sun-Sat week     monthly -> one month     yearly -> one year

function periodInfo(rule, opts) {
  const start = splitKey(rule.startDate);
  const startDay = keyToDayNumber(rule.startDate);
  const N = rule.interval;

  if (rule.frequency === 'daily') {
    return {
      startOf: (k) => startDay + k * N,
      datesOf: (k) => [dayNumberToKey(startDay + k * N)],
      estimate: (fromDay) => Math.floor((fromDay - startDay) / N),
    };
  }

  if (rule.frequency === 'weekly') {
    const back = (weekdayOfKey(rule.startDate) - opts.weekStartsOn + 7) % 7;
    const week0 = startDay - back;
    return {
      startOf: (k) => week0 + 7 * N * k,
      datesOf: (k) => {
        const weekStart = week0 + 7 * N * k;
        return rule.weekdays
          .map((wd) => weekStart + ((wd - opts.weekStartsOn + 7) % 7))
          .sort((a, b) => a - b)
          .map(dayNumberToKey);
      },
      estimate: (fromDay) => Math.floor((fromDay - week0) / (7 * N)),
    };
  }

  if (rule.frequency === 'monthly') {
    const startIndex = start.y * 12 + (start.m - 1);
    const ymOf = (k) => {
      const idx = startIndex + k * N;
      return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
    };
    return {
      startOf: (k) => {
        const { y, m } = ymOf(k);
        return keyToDayNumber(makeKey(y, m, 1));
      },
      datesOf: (k) => {
        const { y, m } = ymOf(k);
        return monthDates(y, m, rule.monthly, opts);
      },
      estimate: (fromDay) => {
        const from = splitKey(dayNumberToKey(fromDay));
        return Math.floor((from.y * 12 + (from.m - 1) - startIndex) / N);
      },
    };
  }

  if (rule.frequency === 'yearly') {
    const yearOf = (k) => start.y + k * N;
    return {
      startOf: (k) => keyToDayNumber(makeKey(yearOf(k), 1, 1)),
      datesOf: (k) => monthDates(yearOf(k), rule.yearly.month, rule.yearly, opts),
      estimate: (fromDay) => Math.floor((splitKey(dayNumberToKey(fromDay)).y - start.y) / N),
    };
  }

  throw new Error(`Unknown frequency: ${rule.frequency}`);
}

// All dates the rule produces between fromKey and toKey (inclusive), in order.
// options: { workingDays, weekStartsOn, limit }  (limit = stop after this many results)
function generateDates(rule, fromKey, toKey, options = {}) {
  const errors = validateRule(rule);
  if (errors.length) throw new Error(errors.join('; '));

  const r = normalizeRule(rule);
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const limit = options.limit === undefined ? Infinity : options.limit;

  const startDay = keyToDayNumber(r.startDate);
  const fromDay = Math.max(keyToDayNumber(fromKey), startDay);
  let endDay = keyToDayNumber(toKey);
  if (r.end.type === 'date') endDay = Math.min(endDay, keyToDayNumber(r.end.date));

  const maxCount = r.end.type === 'count' ? r.end.count : Infinity;
  const info = periodInfo(r, opts);

  // Count-limited rules must be counted from the very first occurrence.
  // Other rules can safely jump close to the requested range.
  let k = r.end.type === 'count' ? 0 : Math.max(0, info.estimate(fromDay) - 1);

  const result = [];
  let emitted = 0;

  for (let guard = 0; guard < MAX_PERIODS; guard++, k++) {
    if (info.startOf(k) > endDay) break;
    for (const key of info.datesOf(k)) {
      const day = keyToDayNumber(key);
      if (day < startDay) continue;
      if (emitted >= maxCount) return result;
      if (day > endDay) return result;
      emitted++;
      if (day >= fromDay) {
        result.push(key);
        if (result.length >= limit) return result;
      }
    }
  }
  return result;
}

// First few occurrence dates, for the "next ~5 occurrences" preview in the form.
function previewDates(rule, count = 5, options = {}) {
  const errors = validateRule(rule);
  if (errors.length) throw new Error(errors.join('; '));
  const r = normalizeRule(rule);
  const from = options.fromKey && options.fromKey > r.startDate ? options.fromKey : r.startDate;
  const horizon = addDaysToKey(from, 366 * 30); // look up to 30 years ahead
  return generateDates(r, from, horizon, { ...options, limit: count });
}

// ---- Plain-language summary ------------------------------------------------------------------

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function ordinal(n) {
  if (n === -1) return 'last';
  const names = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th' };
  return names[n] || `${n}th`;
}

function naturalList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function describeRule(rule) {
  const r = normalizeRule(rule);
  const n = r.interval;
  let text;

  if (r.frequency === 'daily') {
    text = n === 1 ? 'Every day' : `Every ${n} days`;
  } else if (r.frequency === 'weekly') {
    if (n === 1 && r.weekdays.length === 1) {
      text = `Every ${WEEKDAY_LONG[r.weekdays[0]]}`;
    } else {
      const names = r.weekdays.length === 1
        ? WEEKDAY_LONG[r.weekdays[0]]
        : r.weekdays.map((d) => WEEKDAY_SHORT[d]).join(', ');
      text = `${n === 1 ? 'Every week' : `Every ${n} weeks`} on ${names}`;
    }
  } else if (r.frequency === 'monthly') {
    const m = r.monthly;
    if (m.type === 'weekdaysInMonth') {
      const names = m.weekdays.length === 1
        ? WEEKDAY_LONG[m.weekdays[0]]
        : m.weekdays.map((d) => WEEKDAY_SHORT[d]).join(', ');
      text = `Every ${names} of ${n === 1 ? 'every month' : `every ${ordinal(n)} month`}`;
    } else if (m.type === 'dayOfMonth') {
      text = `${n === 1 ? 'Every month' : `Every ${n} months`} on day ${naturalList(m.days.map(String))}`;
    } else if (m.type === 'lastDay') {
      text = `${n === 1 ? 'Every month' : `Every ${n} months`} on the last day`;
    } else if (m.type === 'lastWorkingDay') {
      text = `${n === 1 ? 'Every month' : `Every ${n} months`} on the last working day`;
    } else {
      text = `${n === 1 ? 'Every month' : `Every ${n} months`} on the ${naturalList(m.positions.map(ordinal))} ${WEEKDAY_LONG[m.weekday]}`;
    }
  } else {
    const y = r.yearly;
    const lead = n === 1 ? 'Every year' : `Every ${n} years`;
    if (y.type === 'dayOfMonth') {
      text = `${lead} on ${MONTH_LONG[y.month - 1]} ${y.day}`;
    } else {
      text = `${lead} on the ${naturalList(y.positions.map(ordinal))} ${WEEKDAY_LONG[y.weekday]} of ${MONTH_LONG[y.month - 1]}`;
    }
  }

  text += `, starting ${formatKeyShort(r.startDate)}`;
  if (r.end.type === 'date') {
    const differentYear = r.end.date.slice(0, 4) !== r.startDate.slice(0, 4);
    text += `, until ${formatKeyShort(r.end.date, differentYear)}`;
  } else if (r.end.type === 'count') {
    text += `, for ${r.end.count} occurrence${r.end.count === 1 ? '' : 's'}`;
  }
  return text;
}

module.exports = {
  FREQUENCIES,
  DEFAULT_OPTIONS,
  normalizeRule,
  validateRule,
  generateDates,
  previewDates,
  describeRule,
};
