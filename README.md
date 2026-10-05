# Daily Planner

Task manager where the day is divided into 5 zones by the prayer times.
Full specification: Daily_Planner_Spec.md (kept outside this folder).

## Milestone 1 (this folder)

- `src/core/` - zone engine: planning day, zones, durations, prayer-relative start, "Today"
- `src/core/prayer-adapter.js` - connects the `adhan` prayer-time library
- `src/core/cities.js` - built-in Egyptian cities
- `tests/` - automated tests (spec scenarios 1-11 and 27 plus prayer-library sanity checks)
- `.github/workflows/test.yml` - makes GitHub run the tests on a Windows machine

## Run the tests on GitHub

Upload this folder's contents to a GitHub repository. GitHub runs the tests
automatically. Open the **Actions** tab to see a green check (passed) or a red X (failed).
