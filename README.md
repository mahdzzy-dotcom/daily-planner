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

Tests (spec scenarios 1-17 and 27-28) are in `tests/`.
`.github/workflows/test.yml` makes GitHub run them on a Windows machine on every upload.

## Assumptions made so far

- Asr uses the standard (Shafi) calculation.
- Recurrence weeks run Sunday to Saturday when counting "every N weeks".
- For "After N occurrences", excluded dates still count toward N; added one-offs do not.
- "Last working day" uses Sunday-Thursday unless Settings changes the working days.
