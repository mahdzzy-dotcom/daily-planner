'use strict';

// Small, dependency-free time helpers. All dates are local-time JavaScript Dates.
// A "date key" is a plain calendar date string like "2026-10-04".

const MS_PER_MINUTE = 60000;

function pad(n) {
  return String(n).padStart(2, '0');
}

function dateKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseDateKey(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) throw new Error(`Invalid date key: ${key}`);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function addDaysToKey(key, days) {
  const d = parseDateKey(key);
  d.setDate(d.getDate() + days);
  return dateKey(d);
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * MS_PER_MINUTE);
}

function minutesBetween(a, b) {
  return Math.round((b.getTime() - a.getTime()) / MS_PER_MINUTE);
}

// 403 -> "6h 43m", 45 -> "45m", 0 -> "0m", 60 -> "1h 0m"
function formatDuration(totalMinutes) {
  const m = Math.max(0, Math.round(totalMinutes));
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h > 0 ? `${h}h ${r}m` : `${r}m`;
}

// 12-hour clock with AM/PM, no seconds: "5:05 AM", "12:00 PM", "12:20 AM"
function formatTime12(date) {
  const hours24 = date.getHours();
  const minutes = date.getMinutes();
  const suffix = hours24 >= 12 ? 'PM' : 'AM';
  let hours12 = hours24 % 12;
  if (hours12 === 0) hours12 = 12;
  return `${hours12}:${pad(minutes)} ${suffix}`;
}

module.exports = {
  MS_PER_MINUTE,
  dateKey,
  parseDateKey,
  addDaysToKey,
  addMinutes,
  minutesBetween,
  formatDuration,
  formatTime12,
};
