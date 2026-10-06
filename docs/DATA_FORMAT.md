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

- `start`: `{ "mode": "fixed", "time": "HH:MM" }` (24-hour) or
  `{ "mode": "prayer", "prayer": "fajr|dhuhr|asr|maghrib|isha", "direction": "before|after", "minutes": 10 }`.
- `date`: the calendar date of the start time for one-off tasks; `null` for repeating tasks.
- `recurrence`: `null` for one-off tasks. `frequency` is `daily`, `weekly`, `monthly` or `yearly`; see
  `src/core/recurrence.js` for every field (weekday lists, monthly modes, yearly modes, end rules).
- `exceptions`, `additions`, `overrides` and `completions` are keyed by occurrence date (`YYYY-MM-DD`).
