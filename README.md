# Daily Planner

Task manager where the day is divided into 5 zones by the prayer times.
Full specification: Daily_Planner_Spec.md (kept outside this folder).

## What is in here

Milestone 1 - zone engine
- `src/core/time.js` - date/time helpers, 12-hour and duration formatting
- `src/core/zones.js` - Planning Day, zones, "Today", prayer-relative start, end time
- `src/core/layout.js` - per-zone Total / Scheduled / Free durations, splitting, overlaps
- `src/core/prayer-adapter.js` - connects the `adhan` prayer-time library
- `src/core/cities.js` - built-in Egyptian cities

Milestone 2 - tasks and recurrence
- `src/core/recurrence.js` - rule-based recurrence engine, validation, preview, plain-language summary
- `src/core/tasks.js` - task model, occurrences, exceptions/additions/single edits,
  edit and delete scopes (this / this and following / all), per-occurrence completion,
  "will appear under Planning Day" note

Milestone 3 - reminders and Windows notifications
- `src/core/reminders.js` - reminder offsets, schedule (start - offset), zone-start events,
  notification text, missed-reminders summary
- `src/core/reminder-engine.js` - the background engine: checks every 15 s, shows notifications,
  collects missed reminders, snooze, "Mark as Done" (no window or Windows code inside)
- `src/main/toast.js` - Windows toast adapter for Electron: toast XML with Snooze / Mark as Done
  buttons, `dailyplanner://` action links, Electron notifier

Tests (spec scenarios 1-18, 20, 27-29 and the logic part of 19) are in `tests/`.
`.github/workflows/test.yml` makes GitHub run them on a Windows machine on every upload.

## Assumptions made so far

- Asr uses the standard (Shafi) calculation.
- Recurrence weeks run Sunday to Saturday when counting "every N weeks".
- For "After N occurrences", excluded dates still count toward N; added one-offs do not.
- "Last working day" uses Sunday-Thursday unless Settings changes the working days.
- A reminder up to 2 minutes late is still shown normally; older ones go to the missed summary.
- Completed occurrences get no reminders.
- Notification buttons use a `dailyplanner://` link (registered by the installer) that reaches the
  running app through Electron's single-instance handling (Milestone 5 wires this up).
