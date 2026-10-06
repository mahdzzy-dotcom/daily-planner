'use strict';

// The reminder engine. It has NO window, NO Windows code and NO real timers of its own:
// everything it needs (tasks, prayer times, clock, how to show a notification) is handed in.
// That is what lets it run in the background with the main window closed, and lets the
// tests run it with a fake clock.
//
// How it works: every "tick" (about every 15 seconds) the engine looks at the time window
//   (last tick, now]
// and finds every reminder whose notification time falls inside it:
//   - due now or a moment ago (within the grace period)  -> notification is shown
//   - older than the grace period (PC was off / asleep)  -> goes into the missed-reminders summary
// Because the schedule is recalculated from the tasks on every tick, changes to tasks, rules,
// city, method, prayer adjustments, time zone or the system clock are always picked up.

const { setCompletion, getOccurrences } = require('./tasks');
const {
  DEFAULT_REMINDER_SETTINGS,
  remindersInWindow,
  zoneStartEvents,
  formatTaskNotification,
  formatZoneNotification,
  summarizeMissed,
  formatMissedNotification,
} = require('./reminders');
const { deriveZone } = require('./zones');

const MS_PER_MINUTE = 60000;
const DAY_MS = 24 * 60 * MS_PER_MINUTE;

const DEFAULTS = {
  tickMs: 15000, // how often the engine checks
  graceMs: 2 * MS_PER_MINUTE, // a reminder up to this late is still shown normally
  lookbackMs: DAY_MS, // missed reminders: roughly the previous 24 hours
  keepDeliveredMs: 2 * DAY_MS,
  saveEveryMs: 60000, // how often the "last checked" time is written to disk
};

function emptyState() {
  return { delivered: {}, lastTickAt: null, snoozed: [] };
}

class ReminderEngine {
  // deps:
  //   getTasks()      -> array of tasks
  //   getProvider()   -> current prayer provider (changes when city/method/adjustments change)
  //   getSettings()   -> reminder settings (see DEFAULT_REMINDER_SETTINGS)
  //   notify(payload) -> show a notification (payload is built in reminders.js)
  //   onMissed(items, payload) -> show the missed-reminders summary
  //   updateTask(task)-> save a changed task (used by "Mark as Done")
  //   initialState / saveState(state) -> persistence of the engine's own small state
  //   now() / setInterval / clearInterval -> replaceable for tests
  //   onError(error)  -> optional
  constructor(deps) {
    this.deps = deps;
    this.options = { ...DEFAULTS, ...(deps.options || {}) };
    this.state = { ...emptyState(), ...(deps.initialState || {}) };
    this.state.delivered = { ...this.state.delivered };
    this.state.snoozed = [...(this.state.snoozed || [])];
    this.timer = null;
    this.lastSavedAt = 0;
  }

  now() {
    return this.deps.now ? this.deps.now() : new Date();
  }

  settings() {
    return { ...DEFAULT_REMINDER_SETTINGS, ...(this.deps.getSettings ? this.deps.getSettings() : {}) };
  }

  // ---- Running ---------------------------------------------------------------------------------

  start() {
    this.tick();
    const set = this.deps.setInterval || setInterval;
    this.timer = set(() => this.tick(), this.options.tickMs);
  }

  stop() {
    const clear = this.deps.clearInterval || clearInterval;
    if (this.timer !== null) clear(this.timer);
    this.timer = null;
    this.flush();
  }

  // Call after wake from sleep, a clock change or a time zone change: checks immediately.
  onSystemChange() {
    return this.tick();
  }

  flush() {
    this.save(true);
  }

  // ---- The check ---------------------------------------------------------------------------------

  tick(nowDate = this.now()) {
    const result = { delivered: [], missed: [], snoozed: [] };
    try {
      this.process(nowDate, result);
    } catch (error) {
      if (this.deps.onError) this.deps.onError(error);
      else throw error;
    }
    return result;
  }

  process(nowDate, result) {
    const now = nowDate.getTime();
    const settings = this.settings();
    const o = this.options;
    let changed = false;

    // First ever run, or the clock was set back: just re-anchor. The delivered log prevents repeats.
    if (this.state.lastTickAt === null || now <= this.state.lastTickAt) {
      const firstRun = this.state.lastTickAt === null;
      this.state.lastTickAt = now;
      this.save(firstRun, now);
      return;
    }

    const windowStart = Math.max(this.state.lastTickAt, now - o.lookbackMs);
    const tasks = this.deps.getTasks();
    const provider = this.deps.getProvider();

    if (settings.notificationsEnabled) {
      const toShow = []; // { sortAt, payload }
      const missed = [];

      // 1. Task reminders
      for (const r of remindersInWindow(provider, tasks, windowStart, now, settings)) {
        if (this.state.delivered[r.id]) continue;
        this.state.delivered[r.id] = now;
        changed = true;
        if (now - r.notifyAt.getTime() <= o.graceMs) {
          toShow.push({
            sortAt: r.notifyAt.getTime(),
            occurrenceId: r.occurrenceId,
            payload: formatTaskNotification(r, r.offsetMinutes, settings),
          });
        } else {
          missed.push(r);
        }
      }

      // 2. Optional zone-start notifications: informational, never late, never "missed"
      if (settings.zoneStartNotifications) {
        for (const e of zoneStartEvents(provider, windowStart, now)) {
          if (this.state.delivered[e.id]) continue;
          this.state.delivered[e.id] = now;
          changed = true;
          if (now - e.notifyAt.getTime() <= o.graceMs) {
            toShow.push({ sortAt: e.notifyAt.getTime(), payload: formatZoneNotification(e, settings) });
          }
        }
      }

      // 3. Snoozed reminders that are now due
      const stillWaiting = [];
      for (const snooze of this.state.snoozed) {
        if (snooze.until > now) {
          stillWaiting.push(snooze);
          continue;
        }
        changed = true;
        const occurrence = this.findOccurrence(tasks, provider, snooze.taskId, snooze.dateKey, settings);
        if (!occurrence || occurrence.done) continue; // task deleted, moved away, or already done
        const zone = deriveZone(provider, occurrence.start);
        const item = {
          kind: 'snooze',
          id: `snooze:${occurrence.id}@${snooze.until}`,
          occurrenceId: occurrence.id,
          taskId: occurrence.taskId,
          dateKey: occurrence.dateKey,
          title: occurrence.title,
          start: occurrence.start,
          end: occurrence.end,
          zoneName: zone.zoneName,
          notifyAt: new Date(snooze.until),
        };
        if (now - snooze.until <= o.graceMs) {
          const minutesUntil = Math.round((occurrence.start.getTime() - now) / MS_PER_MINUTE);
          toShow.push({
            sortAt: snooze.until,
            occurrenceId: occurrence.id,
            payload: formatTaskNotification(item, minutesUntil, settings),
          });
          result.snoozed.push(item);
        } else if (now - snooze.until <= o.lookbackMs) {
          missed.push(item);
        }
      }
      if (stillWaiting.length !== this.state.snoozed.length) this.state.snoozed = stillWaiting;

      // Show on-time notifications, oldest first
      toShow.sort((a, b) => a.sortAt - b.sortAt);
      for (const { payload } of toShow) {
        this.show(() => this.deps.notify(payload));
        result.delivered.push(payload);
      }

      // Missed-reminders summary. A task that was just notified on time is not also "missed".
      const notifiedNow = new Set(toShow.map((entry) => entry.occurrenceId).filter(Boolean));
      const reallyMissed = missed.filter((r) => !notifiedNow.has(r.occurrenceId));
      if (reallyMissed.length > 0) {
        const items = summarizeMissed(reallyMissed, nowDate);
        const payload = formatMissedNotification(items, settings);
        result.missed = items;
        this.show(() => (this.deps.onMissed ? this.deps.onMissed(items, payload) : this.deps.notify(payload)));
      }
    } else if (this.state.snoozed.length > 0) {
      // Notifications are off: due snoozes are dropped quietly, future ones wait.
      const before = this.state.snoozed.length;
      this.state.snoozed = this.state.snoozed.filter((s) => s.until > now);
      if (this.state.snoozed.length !== before) changed = true;
    }

    // Forget old delivery records
    const cutoff = now - o.keepDeliveredMs;
    for (const id of Object.keys(this.state.delivered)) {
      if (this.state.delivered[id] < cutoff) {
        delete this.state.delivered[id];
        changed = true;
      }
    }

    this.state.lastTickAt = now;
    this.save(changed, now);
  }

  show(fn) {
    try {
      fn();
    } catch (error) {
      if (this.deps.onError) this.deps.onError(error);
    }
  }

  findOccurrence(tasks, provider, taskId, dateKey, settings) {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return null;
    const options = settings && settings.workingDays ? { workingDays: settings.workingDays } : {};
    return getOccurrences(provider, task, dateKey, dateKey, options)[0] || null;
  }

  // ---- Notification buttons ----------------------------------------------------------------------

  // action: { type: 'snooze' | 'done', taskId, dateKey }
  handleAction(action) {
    const now = this.now().getTime();
    const settings = this.settings();

    if (action.type === 'snooze') {
      const until = now + settings.snoozeMinutes * MS_PER_MINUTE;
      this.state.snoozed = this.state.snoozed.filter(
        (s) => !(s.taskId === action.taskId && s.dateKey === action.dateKey)
      );
      this.state.snoozed.push({ taskId: action.taskId, dateKey: action.dateKey, until });
      this.save(true);
      return { type: 'snooze', until: new Date(until) };
    }

    if (action.type === 'done') {
      const task = this.deps.getTasks().find((t) => t.id === action.taskId);
      if (!task) return { type: 'done', ok: false };
      this.deps.updateTask(setCompletion(task, action.dateKey, true));
      this.state.snoozed = this.state.snoozed.filter(
        (s) => !(s.taskId === action.taskId && s.dateKey === action.dateKey)
      );
      this.save(true);
      return { type: 'done', ok: true };
    }

    throw new Error(`Unknown notification action: ${action.type}`);
  }

  // ---- For the bell / "upcoming" list ---------------------------------------------------------------

  upcoming(count = 10, nowDate = this.now(), days = 14) {
    const from = nowDate.getTime();
    const to = from + days * DAY_MS;
    return remindersInWindow(this.deps.getProvider(), this.deps.getTasks(), from, to, this.settings()).slice(0, count);
  }

  // ---- Persistence ------------------------------------------------------------------------------------

  save(force, nowMs = this.now().getTime()) {
    if (!this.deps.saveState) return;
    if (force || nowMs - this.lastSavedAt >= this.options.saveEveryMs) {
      this.deps.saveState(JSON.parse(JSON.stringify(this.state)));
      this.lastSavedAt = nowMs;
    }
  }
}

module.exports = { ReminderEngine, emptyState, DEFAULTS };
