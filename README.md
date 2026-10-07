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
- `build/` - icon and installer script
- `docs/` - HOW_TO_INSTALL_AND_USE.md (for the user), ACCEPTANCE_CHECKLIST.md (what is checked where, and what to
  try on a real PC), DATA_FORMAT.md (backup file format)

## GitHub does the work

- **Run tests**: runs the tests on every upload.
- **Build Windows installer**: builds `Daily-Planner-Setup-<version>.exe`. Open the Actions tab, click the
  newest "Build Windows installer" run, and download "Daily-Planner-Installer" at the bottom of the page.

## Start time options

Fixed Time, Relative to Prayer, and Relative to Task ("15 minutes after the end of <task>").

## First run

A welcome screen asks for the city once. Settings -> Reminders has a "Send a test notification" button that also
tests the Snooze / Mark as Done buttons.

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
- Closing or minimizing the window hides it to the tray; only "Exit" in the tray menu stops the app.
- The "still running in the background" message is shown once, at the first close (or again after it is
  switched back on in Settings).
- Start with Windows registers the installed app with the `--hidden` option so it starts in the tray.
- A change of the PC's time zone is noticed within about a minute (and at wake from sleep); this needs a
  check on a real Windows PC.
- Relative to Task: a task follows the SAME DAY's occurrence of the other task (matched by calendar date);
  if the other task is not on that day, the backup start time is used and a warning is shown.
- Deleting a task completely (one-off, or "All occurrences") warns about tasks that follow it, and they keep the
  times they have now as fixed times. Deleting one day only does not freeze followers (they use the backup time).
- A follower that crosses midnight cannot be frozen exactly; it falls back to its backup time (and you are told).
- Marking a task done does not move the tasks that follow it (they follow the planned times).
