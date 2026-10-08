'use strict';

// Reminder calculation (pure functions, no timers, no Windows code).
//
//   Notification Time = actual resolved Start Time of the occurrence - Reminder Offset
//
// Everything is computed on demand from the tasks, so a change to a task, a rule, the city,
// the calculation method or a prayer adjustment is picked up automatically the next time
// the schedule is calculated.

const { addMinutes, addDaysToKey, dateKey, formatTime12, formatDuration } = require('./time');
const { PRAYERS, ZONE_NAMES, deriveZone } = require('./zones');
const { getOccurrences } = require('./tasks');

const DEFAULT_REMINDER_SETTINGS = {
  notificationsEnabled: true,
  soundEnabled: true,
  defaultReminderOffsetMinutes: 10,
  snoozeMinutes: 5,
  zoneStartNotifications: false, // optional, default Off
  fullScreenAlerts: true, // master switch for full-screen alerts (each task has its own switch too)
};

function withDefaults(settings) {
  return { ...DEFAULT_REMINDER_SETTINGS, ...(settings || {}) };
}

// The distinct reminder offsets (minutes before start) for an occurrence.
// Reminder off -> none.  Reminder on with an empty list -> the default offset.
// Identical offsets count once.  Largest first (= earliest notification first).
function reminderOffsets(reminders, settings) {
  if (!reminders || !reminders.enabled) return [];
  const s = withDefaults(settings);
  const list = Array.isArray(reminders.offsets) ? reminders.offsets : [];
  const offsets = list.length > 0 ? list : [s.defaultReminderOffsetMinutes];
  return Array.from(new Set(offsets)).sort((a, b) => b - a);
}

function largestOffsetMinutes(tasks, settings) {
  const s = withDefaults(settings);
  let max = s.defaultReminderOffsetMinutes;
  const consider = (reminders) => {
    if (reminders && Array.isArray(reminders.offsets)) {
      for (const o of reminders.offsets) if (o > max) max = o;
    }
  };
  for (const task of tasks) {
    consider(task.reminders);
    for (const key of Object.keys(task.overrides || {})) consider(task.overrides[key].reminders);
  }
  return max;
}

// All TASK reminders whose notification time is after fromMs and at or before toMs.
// Completed occurrences get no reminders. Sorted by notification time.
function remindersInWindow(provider, tasks, fromMs, toMs, settings, options = {}) {
  // Recurrence rules such as "last working day" need the user's working days from Settings.
  if (settings && settings.workingDays && !options.workingDays) {
    options = { ...options, workingDays: settings.workingDays };
  }
  options = { ...options, tasks }; // lets tasks that follow other tasks find them
  const margin = Math.ceil(largestOffsetMinutes(tasks, settings) / 1440);
  const fromKey = addDaysToKey(dateKey(new Date(fromMs)), -2);
  const toKey = addDaysToKey(dateKey(new Date(toMs)), 2 + margin);

  const result = [];
  for (const task of tasks) {
    for (const occ of getOccurrences(provider, task, fromKey, toKey, options)) {
      if (occ.done) continue;
      for (const offset of reminderOffsets(occ.reminders, settings)) {
        const notifyAt = addMinutes(occ.start, -offset);
        const t = notifyAt.getTime();
        if (t > fromMs && t <= toMs) {
          const zone = deriveZone(provider, occ.start);
          result.push({
            // The notification time is part of the id, so moving a task creates a fresh reminder.
            id: `${occ.id}#${offset}@${t}`,
            kind: 'task',
            occurrenceId: occ.id,
            taskId: occ.taskId,
            dateKey: occ.dateKey,
            offsetMinutes: offset,
            fullScreen: Boolean(occ.reminders && occ.reminders.fullScreen),
            notifyAt,
            title: occ.title,
            start: occ.start,
            end: occ.end,
            zoneIndex: zone.zoneIndex,
            zoneName: zone.zoneName,
          });
        }
      }
    }
  }
  return result.sort((a, b) => a.notifyAt - b.notifyAt || (a.id < b.id ? -1 : 1));
}

// Occurrences with a full-screen alert whose start moment is after fromMs and at or before toMs.
// The alert appears at the exact start time (not before). Completed occurrences get none.
function alertsInWindow(provider, tasks, fromMs, toMs, settings, options = {}) {
  if (settings && settings.workingDays && !options.workingDays) {
    options = { ...options, workingDays: settings.workingDays };
  }
  options = { ...options, tasks };
  const fromKey = addDaysToKey(dateKey(new Date(fromMs)), -2);
  const toKey = addDaysToKey(dateKey(new Date(toMs)), 2);

  const result = [];
  for (const task of tasks) {
    for (const occ of getOccurrences(provider, task, fromKey, toKey, options)) {
      if (occ.done || !(occ.reminders && occ.reminders.fullScreen)) continue;
      const t = occ.start.getTime();
      if (t > fromMs && t <= toMs) {
        const zone = deriveZone(provider, occ.start);
        result.push({
          id: `alert:${occ.id}@${t}`,
          kind: 'alert',
          occurrenceId: occ.id,
          taskId: occ.taskId,
          dateKey: occ.dateKey,
          title: occ.title,
          notes: occ.notes,
          priority: occ.priority,
          categoryId: occ.categoryId,
          durationMinutes: occ.durationMinutes,
          start: occ.start,
          end: occ.end,
          zoneIndex: zone.zoneIndex,
          zoneName: zone.zoneName,
        });
      }
    }
  }
  return result.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
}

// Optional "a Zone begins" events: one at each prayer time (Fajr, Dhuhr, Asr, Maghrib, Isha).
function zoneStartEvents(provider, fromMs, toMs) {
  const firstKey = addDaysToKey(dateKey(new Date(fromMs)), -1);
  const lastKey = addDaysToKey(dateKey(new Date(toMs)), 1);
  const events = [];

  for (let key = firstKey; key <= lastKey; key = addDaysToKey(key, 1)) {
    const today = provider(key);
    PRAYERS.forEach((prayer, i) => {
      const at = today[prayer];
      const t = at.getTime();
      if (t > fromMs && t <= toMs) {
        const end = i < 4 ? today[PRAYERS[i + 1]] : provider(addDaysToKey(key, 1)).fajr;
        events.push({
          id: `zone:${key}:${i + 1}@${t}`,
          kind: 'zone',
          notifyAt: at,
          zoneIndex: i + 1,
          zoneName: ZONE_NAMES[i],
          zoneEnd: end,
        });
      }
    });
  }
  return events.sort((a, b) => a.notifyAt - b.notifyAt);
}

// ---- Notification text -------------------------------------------------------------------------------

function humanMinutes(minutes) {
  return minutes < 60 ? `${minutes} min` : formatDuration(minutes);
}

// Content: task title, start time and Zone name (spec 10.3).
// minutesUntilStart is how long until the task starts (the reminder offset, or the real
// remaining time for a snoozed reminder).
function formatTaskNotification(item, minutesUntilStart, settings) {
  const s = withDefaults(settings);
  const startText = formatTime12(item.start);
  let first;
  if (minutesUntilStart > 0) first = `Starts in ${humanMinutes(minutesUntilStart)} · ${startText}`;
  else if (minutesUntilStart === 0) first = `Starts now · ${startText}`;
  else first = `Started at ${startText}`;
  const second = `Zone: ${item.zoneName}`;

  return {
    kind: item.kind === 'snooze' ? 'snooze' : 'task',
    id: item.id,
    title: item.title,
    lines: [first, second],
    body: `${first}\n${second}`,
    silent: !s.soundEnabled,
    taskId: item.taskId,
    dateKey: item.dateKey,
    actions: [
      { type: 'snooze', label: `Snooze ${s.snoozeMinutes} min` },
      { type: 'done', label: 'Mark as Done' },
    ],
  };
}

function formatZoneNotification(event, settings) {
  const s = withDefaults(settings);
  const line = `Until ${formatTime12(event.zoneEnd)}`;
  return {
    kind: 'zone',
    id: event.id,
    title: `${event.zoneName} has started`,
    lines: [line],
    body: line,
    silent: !s.soundEnabled,
    taskId: null,
    dateKey: null,
    actions: [],
  };
}

// ---- Missed reminders ----------------------------------------------------------------------------------

// One entry per occurrence (its earliest missed reminder), oldest first.
function summarizeMissed(reminders, now) {
  const nowMs = now.getTime();
  const byOccurrence = new Map();
  for (const r of reminders) {
    const existing = byOccurrence.get(r.occurrenceId);
    if (!existing || r.notifyAt < existing.notifyAt) byOccurrence.set(r.occurrenceId, r);
  }
  return Array.from(byOccurrence.values())
    .sort((a, b) => a.notifyAt - b.notifyAt)
    .map((r) => ({
      occurrenceId: r.occurrenceId,
      taskId: r.taskId,
      dateKey: r.dateKey,
      title: r.title,
      start: r.start,
      notifyAt: r.notifyAt,
      zoneName: r.zoneName,
      alreadyStarted: r.start.getTime() <= nowMs,
    }));
}

function formatMissedNotification(items, settings) {
  const s = withDefaults(settings);
  const n = items.length;
  const shown = items.slice(0, 3).map((i) => `${formatTime12(i.start)} · ${i.title}`);
  if (n > shown.length) shown.push(`and ${n - shown.length} more`);
  return {
    kind: 'missed',
    id: `missed:${items[0] ? items[0].notifyAt.getTime() : 0}`,
    title: n === 1 ? 'You missed 1 reminder' : `You missed ${n} reminders`,
    lines: shown,
    body: shown.join('\n'),
    silent: !s.soundEnabled,
    taskId: null,
    dateKey: null,
    actions: [],
  };
}

module.exports = {
  DEFAULT_REMINDER_SETTINGS,
  reminderOffsets,
  remindersInWindow,
  alertsInWindow,
  zoneStartEvents,
  formatTaskNotification,
  formatZoneNotification,
  summarizeMissed,
  formatMissedNotification,
};
