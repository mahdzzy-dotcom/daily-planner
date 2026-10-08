# Acceptance checklist

Every scenario in Section 16 of the specification (plus the later additions 27-37), where it is checked
automatically, and what still has to be tried on a real Windows computer.

Automatic tests run on every upload to GitHub (**Actions -> Run tests**). `tools/ui-check.js` clicks through the
real screens in a test browser; it was run while building and is not part of the installed app.

| # | What is checked | Checked automatically in | Also try on a real PC |
| --- | --- | --- | --- |
| 1 | Zone derivation for typical times | tests/zones.test.js | - |
| 2 | A moment exactly at a prayer time belongs to the zone that starts there | tests/zones.test.js | - |
| 3 | 2:00 AM is Zone 5 of the previous Planning Day | tests/zones.test.js, tests/service.test.js | - |
| 4 | Zone totals (Zone 1 = 6h 43m) | tests/zones.test.js, tests/service.test.js | - |
| 5 | Scheduled 3h 10m / Free 3h 33m | tests/zones.test.js | - |
| 6 | Overlaps merged and flagged | tests/zones.test.js | - |
| 7 | Task crossing Dhuhr: 18 / 42 minutes, 'Continues from' | tests/zones.test.js, tests/service.test.js | - |
| 8 | Zone 5 task running past the next Fajr | tests/zones.test.js | - |
| 9 | End time = start + duration (also past midnight) | tests/zones.test.js | - |
| 10 | '10 minutes after Asr' follows each day's Asr | tests/zones.test.js, tests/task-relative.test.js | - |
| 11 | Daily 5:10 AM task changes zone across the year | tests/zones.test.js | - |
| 12 | Every 3 weeks on Sunday and Thursday | tests/recurrence.test.js | - |
| 13 | 1st and 3rd Friday of every 2 months; last Sunday; day 31 | tests/recurrence.test.js | - |
| 14 | Limits: 20 occurrences, until Dec 31, no end | tests/recurrence.test.js | - |
| 15 | Exceptions, additions, single-occurrence edits | tests/tasks.test.js | - |
| 16 | Edit scope: this / this and following / all | tests/tasks.test.js, tests/service.test.js | - |
| 17 | Per-occurrence completion | tests/tasks.test.js | - |
| 18 | Reminders {15, 0}; daily; prayer-relative | tests/reminders.test.js, tests/reminder-engine.test.js | See check 6 below (real notification) |
| 19 | Notifications with the window closed | tests/main.test.js (window hidden, engine still notifies) | Check 7 below |
| 20 | Missed reminders summary | tests/reminder-engine.test.js | Check 9 below |
| 21 | Second launch focuses the existing window | tests/main.test.js | Check 8 below |
| 22 | Start with Windows, hidden in the tray | tests/main.test.js (registers --hidden login item) | Check 10 below |
| 23 | Settings changes update zones, durations and notifications | tests/service.test.js, tests/reminder-engine.test.js | - |
| 24 | Daylight saving / time zone change | tests/dst.test.js (real Egyptian 2026 changes); the app also checks every minute and after wake | Check 11 below (changing the time zone while the app runs) |
| 25 | Persistence, export / import, damaged-file recovery | tests/service.test.js | Check 12 below (reinstall keeps data) |
| 26 | Theme and 12-hour times everywhere | tools/ui-check.js (theme), tests (12-hour labels) | Look at both themes once |
| 27 | 'Today' is the Planning Day containing now | tests/zones.test.js, tests/service.test.js | - |
| 28 | Date field vs Planning Day, 'Will appear under...' note | tests/tasks.test.js, tests/service.test.js, tools/ui-check.js | - |
| 29 | Zone-start notifications are never late, never 'missed' | tests/reminder-engine.test.js | - |
| 38 | Full-screen alert at the exact start moment | tests/alerts.test.js, tests/main.test.js | Check 14 below |
| 39 | Alert content (name, notes, details, long text, Arabic) | tools/ui-check.js, tests/main.test.js | Check 14 below |
| 40 | Per-task switch, default for new tasks, master switch | tests/alert-settings.test.js, tests/alerts.test.js | - |
| 41 | Customization applies to the alert and the preview; looks; limits; backups | tests/alert-settings.test.js, tools/ui-check.js | Check 15 below |
| 42 | All screens / main screen only | tests/main.test.js | Check 16 below (if you have two screens) |
| 43 | Buttons (Got it, Snooze, Open task, Mark as Done) and the queue | tests/main.test.js, tests/alerts.test.js, tools/ui-check.js | Check 14 below |
| 44 | Protection against accidental dismissal | tools/ui-check.js | Check 14 below |
| 45 | Late / missed: no late alert, missed summary | tests/alerts.test.js | - |
| 46 | The alert replaces the plain notification at the start | tests/alerts.test.js, tests/main.test.js | - |
| 30-37 | Relative to a task: resolution, chains, repeating, backup time, loops, deleting, split edits, reminders | tests/task-relative.test.js, tools/ui-check.js | Check 5 below |

## Things only a real Windows computer can confirm

Do these once after installing. They are the parts that cannot be tested without Windows itself.

1. **Install**: run the installer; the SmartScreen steps work; the wizard finishes; Start menu and Desktop shortcuts exist.
2. **Welcome screen**: choose your city. Compare the five prayer times with a timetable you trust.
3. **Add a task** at a time two minutes from now with a reminder at 0 minutes.
4. **Close the window** (X). The message says Daily Planner is still running; the tray icon is there.
5. **Relative to Task**: add two tasks in sequence (the second 5 minutes after the end of the first); move the first one and see the second move.
6. **Notification**: with the window closed, a Windows notification appears on time, showing the title, start time and zone.
   Also use Settings -> **Send a test notification**: click **Snooze** and **Mark as Done** and confirm each answers with "The notification buttons work".
7. **Real task buttons**: let a real reminder appear, click **Mark as Done**, then open the app: the task is checked. Repeat with **Snooze**: it comes back after the snooze time.
8. **Single instance**: with the window hidden, double-click the Desktop shortcut: the existing window appears; no second copy in the tray.
9. **Missed reminders**: make a task with a reminder 5 minutes ahead, choose Exit from the tray, wait 10 minutes, start the app: a "You missed ..." message appears.
10. **Start with Windows**: switch it on in Settings, sign out and in (or restart): the app is in the tray and no window opens.
11. **Time zone**: with the app running, change the Windows time zone; within a minute the zone times and the upcoming reminders (bell icon) follow the new clock.
12. **Reinstall**: Export data; uninstall (answer **No** when asked whether to delete your data); reinstall; tasks are still there. Then import the backup file into a fresh install.
13. **Uninstall**: choose to delete data; reinstall: the app is empty and shows the welcome screen.

14. **Full-screen alert**: add a task starting 2 minutes from now with "Full-screen alert at the start time" switched on. Open any other program (a browser, a document) and keep working. At exactly the start time the full-screen reminder appears over it, showing the name and notes. Try Snooze (it returns), Open task, Mark as Done, and Got it. Press a few keys right when it appears: it must not close by accident.
15. **Look**: Settings -> Full-screen reminder: choose a ready-made look, change a color and the name size, click **Preview full screen**; the real reminder looks like the small preview.
16. **Two screens** (if you have them): the reminder covers both. Choose "Main screen only" and check that only one is covered.
17. **Limit check** (optional): start a video or game in full screen and see whether the reminder appears over it; some exclusive full-screen programs do not allow it.

If any of these fails, note which number and what you saw, and send it back.
