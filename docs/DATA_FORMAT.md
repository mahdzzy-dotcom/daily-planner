# Daily Planner backup file format

Export / Import (Settings -> Data) uses one JSON file. Version 1:

```json
{
  "app": "daily-planner",
  "formatVersion": 1,
  "exportedAt": "2026-10-04T10:00:00.000Z",
  "settings":   { ... },
  "categories": [ { "id": "cat-work", "name": "Work", "color": "#3b82f6" } ],
  "tasks":      [ { ... } ]
}
```

- `formatVersion` is checked on import. A file with a NEWER version than the app understands is refused with a
  friendly message; older versions will be converted step by step by future versions of the app.
- Importing replaces all tasks, categories and settings. Damaged tasks or categories in the file are skipped
  and reported; the rest is imported.
- Only what the user entered is stored. Zones, end times, durations, generated occurrences and prayer times
  are always recalculated and never saved.

## Task

```json
{
  "id": "uuid",
  "title": "Gym",
  "start": { "mode": "fixed", "time": "09:00" },
  "durationMinutes": 60,
  "date": null,
  "recurrence": {
    "startDate": "2026-10-02", "frequency": "weekly", "interval": 1, "weekdays": [5],
    "end": { "type": "never" }
  },
  "reminders": { "enabled": true, "offsets": [15, 0] },
  "priority": "Medium",
  "categoryId": "cat-health",
  "notes": "",
  "exceptions": ["2026-11-13"],
  "additions": ["2026-11-14"],
  "overrides": { "2026-10-09": { "start": { "mode": "fixed", "time": "08:00" } } },
  "completions": { "2026-10-02": true }
}
```

- `start`: `{ "mode": "fixed", "time": "HH:MM" }` (24-hour),
  `{ "mode": "prayer", "prayer": "fajr|dhuhr|asr|maghrib|isha", "direction": "before|after", "minutes": 10 }`, or
  `{ "mode": "task", "taskId": "...", "point": "start|end", "direction": "before|after", "minutes": 15, "fallbackTime": "HH:MM" }`
  (starts relative to another task's start or end on the same date; `fallbackTime` is used, with a warning,
  on days when that task has no occurrence).
- `continuedFrom` (optional): the id of the task this one was split from by a "This and following" edit.
  Tasks that follow the original keep following the later part through this link.
- `date`: the calendar date of the start time for one-off tasks; `null` for repeating tasks.
- `recurrence`: `null` for one-off tasks. `frequency` is `daily`, `weekly`, `monthly` or `yearly`; see
  `src/core/recurrence.js` for every field (weekday lists, monthly modes, yearly modes, end rules).
- `exceptions`, `additions`, `overrides` and `completions` are keyed by occurrence date (`YYYY-MM-DD`).

## Full-screen alert

- Each task's `reminders` object may contain `"fullScreen": true` (missing means off). Single-occurrence edits in
  `overrides` can carry their own `reminders`, so one day can differ.
- `settings` contains `fullScreenAlerts`, `fullScreenDefaultForNewTasks`, `alertScreens` (`"all"` or `"main"`) and
  `alertAppearance` (colors as `#rrggbb`, `fontFamily`, `alignment`, and the groups `name`, `notes` and `show`).
  Missing or invalid values are replaced by the defaults when a backup is imported.
