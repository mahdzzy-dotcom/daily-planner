# Daily Planner

Windows task manager where the day is divided into 5 zones by the prayer times.
Full specification: Daily_Planner_Spec.md (kept outside this folder).

## Folders

- `src/core/` - all the logic (no screens, no Windows): zones, durations, prayer times, recurrence,
  tasks, reminders, settings, saved-data format
- `src/main/` - the Windows app itself (Electron): window, saved data, planner service, Windows
  notifications, installer-related files
- `src/renderer/` - the screens (Daily View, task form, Settings)
- `tests/` - automated tests (spec scenarios 1-18, 20, 27-29 and many more)
- `tools/` - screenshot / click-through tools used while building (not part of the installed app)
- `build/` - icon and installer script; `docs/` - backup file format

## GitHub does the work

- **Run tests**: runs the tests on every upload.
- **Build Windows installer**: builds `Daily-Planner-Setup-<version>.exe`. Open the Actions tab, click the
  newest "Build Windows installer" run, and download "Daily-Planner-Installer" at the bottom of the page.

## Assumptions made so far

- Asr uses the standard (Shafi) calculation.
- Recurrence weeks run Sunday to Saturday when counting "every N weeks".
- For "After N occurrences", excluded dates still count toward N; added one-offs do not.
- "Last working day" uses the working days from Settings (default Sunday-Thursday).
- A reminder up to 2 minutes late is still shown normally; older ones go to the missed summary.
- Completed occurrences get no reminders.
- New tasks start with reminders On and no custom times, so the default reminder time (10 minutes) is used.
- The Hijri date shown is the Umm al-Qura date of the Planning Day's start date.
- Notification buttons use a `dailyplanner://` link (registered by the installer) handed to the running app.
- Milestone 4 build: closing the window quits the app. Milestone 5 changes this to "keep running in the tray".
