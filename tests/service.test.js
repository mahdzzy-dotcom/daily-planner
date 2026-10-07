'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { PlannerService, PUBLIC_METHODS } = require('../src/main/service');
const { FileStore, MemoryStore } = require('../src/main/store');
const { emptyData, defaultCategories, normalizeData, parseImport, buildExport } = require('../src/core');
const { at, constantProvider } = require('./helpers');

const DAY = '2026-10-04';
const fixed = (time) => ({ mode: 'fixed', time });

function makeService(options = {}) {
  let counter = 0;
  const calls = { providerBuilds: 0, dataChanged: 0, settingsChanged: [] };
  const store = options.store || new MemoryStore();
  const service = new PlannerService({
    store,
    now: () => options.now || at(DAY, '10:00'),
    newId: () => `id${++counter}`,
    providerFactory: () => {
      calls.providerBuilds += 1;
      return constantProvider;
    },
    onDataChanged: () => (calls.dataChanged += 1),
    onSettingsChanged: (s) => calls.settingsChanged.push(s),
  });
  return { service, store, calls };
}

function form(extra = {}) {
  return {
    title: 'Study SQL',
    start: fixed('08:00'),
    durationMinutes: 90,
    date: DAY,
    recurrence: null,
    reminders: { enabled: true, offsets: [] },
    priority: 'Medium',
    categoryId: null,
    notes: '',
    ...extra,
  };
}

function fridayForm(extra = {}) {
  return form({
    title: 'Gym',
    start: fixed('09:00'),
    durationMinutes: 60,
    recurrence: { startDate: '2026-10-02', frequency: 'weekly', interval: 1, weekdays: [5] },
    ...extra,
  });
}

function titlesOf(day, zoneIndex) {
  return day.zones[zoneIndex - 1].tasks.map((t) => t.title);
}

// ---- Daily View ------------------------------------------------------------------------------------------
test('The first-run welcome flag is a normal setting, off by default', () => {
  const store = new MemoryStore();
  const service = new PlannerService({ store, now: () => at(DAY, '10:00'), providerFactory: () => constantProvider });
  assert.equal(service.getSettings().welcomeShown, false);
  service.saveSettings({ cityName: 'Alexandria', welcomeShown: true });
  assert.equal(service.getSettings().cityName, 'Alexandria');
  assert.equal(service.getSettings().welcomeShown, true);
  assert.throws(() => service.saveSettings({ welcomeShown: 'yes' }), /on or off/);
});

test('Start-up information', () => {
  const { service } = makeService();
  const b = service.bootstrap();
  assert.equal(b.currentPlanningDayKey, DAY);
  assert.ok(b.cities.includes('Cairo'));
  assert.equal(b.settings.cityName, 'Cairo');
  assert.equal(b.categories.length, 5);
  assert.ok(b.methods.find((m) => m.key === 'egyptian').label.includes('Egyptian'));
});

test('An empty day still shows all 5 zones with their times and full free duration', () => {
  const { service } = makeService();
  const day = service.getDay(DAY);
  assert.equal(day.zones.length, 5);
  assert.deepEqual(day.zones.map((z) => z.name), [
    'Fajr → Dhuhr', 'Dhuhr → Asr', 'Asr → Maghrib', 'Maghrib → Isha', 'Isha → Fajr',
  ]);
  const z1 = day.zones[0];
  assert.equal(z1.startLabel, '5:05 AM');
  assert.equal(z1.endLabel, '11:48 AM');
  assert.equal(z1.totalLabel, '6h 43m');
  assert.equal(z1.scheduledLabel, '0m');
  assert.equal(z1.freeLabel, '6h 43m');
  assert.equal(day.dateTitle, 'Sunday, October 4, 2026');
  assert.equal(day.planningLine, 'Planning Day: Oct 4 → Oct 5');
  assert.equal(day.isCurrentDay, true);
  assert.match(day.hijri, /1448/);
});

test('The current zone is highlighted only on the current Planning Day', () => {
  const { service } = makeService({ now: at(DAY, '10:00') });
  const today = service.getDay(DAY);
  assert.deepEqual(today.zones.map((z) => z.isCurrent), [true, false, false, false, false]);
  assert.ok(today.zones[0].nowPct > 0 && today.zones[0].nowPct < 100);
  assert.ok(service.getDay('2026-10-05').zones.every((z) => !z.isCurrent));

  const { service: late } = makeService({ now: at('2026-10-05', '02:00') });
  assert.equal(late.bootstrap().currentPlanningDayKey, DAY, '2:00 AM still belongs to the Oct 4 Planning Day');
  assert.deepEqual(late.getDay(DAY).zones.map((z) => z.isCurrent), [false, false, false, false, true]);
});

test('A new task appears in the right zone with all the row details', () => {
  const { service } = makeService();
  const { taskId } = service.saveTask({
    mode: 'create',
    form: form({ priority: 'High', categoryId: 'cat-study', reminders: { enabled: true, offsets: [15] } }),
  });
  const day = service.getDay(DAY);
  assert.deepEqual(titlesOf(day, 1), ['Study SQL']);
  const row = day.zones[0].tasks[0];
  assert.equal(row.taskId, taskId);
  assert.equal(row.startLabel, '8:00 AM');
  assert.equal(row.endLabel, '9:30 AM');
  assert.equal(row.durationLabel, '1h 30m');
  assert.equal(row.priority, 'High');
  assert.equal(row.categoryName, 'Study');
  assert.equal(row.hasReminders, true);
  assert.equal(row.isRecurring, false);
  assert.equal(row.done, false);
  assert.equal(row.overdue, true, 'it ended at 9:30 AM and it is now 10:00 AM');
  assert.equal(day.zones[0].scheduledLabel, '1h 30m');
  assert.equal(day.zones[0].freeLabel, '5h 13m');
  assert.equal(day.zones[0].segments.length, 1);
});

test('Overdue: a task whose time has passed and is not done is flagged', () => {
  const { service } = makeService({ now: at(DAY, '12:00') });
  const { taskId } = service.saveTask({ mode: 'create', form: form() });
  assert.equal(service.getDay(DAY).zones[0].tasks[0].overdue, true);
  service.setDone({ taskId, dateKey: DAY, done: true });
  const row = service.getDay(DAY).zones[0].tasks[0];
  assert.equal(row.done, true);
  assert.equal(row.overdue, false);
});

test('After-midnight task: shown under the earlier Planning Day, Zone 5, with a "next day" flag', () => {
  const { service } = makeService();
  service.saveTask({ mode: 'create', form: form({ title: 'Night study', start: fixed('02:00'), date: '2026-10-05' }) });
  const day4 = service.getDay(DAY);
  assert.deepEqual(titlesOf(day4, 5), ['Night study']);
  assert.equal(day4.zones[4].tasks[0].afterMidnight, true);
  assert.equal(service.getDay('2026-10-05').zones.flatMap((z) => z.tasks).length, 0);
});

test('A task crossing a zone boundary shows "continues" in the next zone and overlaps are flagged', () => {
  const { service } = makeService();
  service.saveTask({ mode: 'create', form: form({ title: 'Long call', start: fixed('11:30'), durationMinutes: 60 }) });
  service.saveTask({ mode: 'create', form: form({ title: 'Other', start: fixed('11:45'), durationMinutes: 30 }) });
  const day = service.getDay(DAY);
  assert.equal(day.zones[0].tasks[0].extendsPastZoneEnd, true);
  assert.ok(day.zones[0].tasks.every((t) => t.overlaps));
  assert.equal(day.zones[1].continued[0].title, 'Long call');
  assert.equal(day.zones[1].continued[0].endLabel, '12:30 PM');
  assert.equal(day.zones[1].continued[0].minutesLabel, '42m');
});

test('Unknown days are rejected', () => {
  const { service } = makeService();
  assert.throws(() => service.getDay('nonsense'), /not valid/);
});

test('Hijri adjustment moves the Hijri date by one day', () => {
  const { service } = makeService();
  const base = service.getDay(DAY).hijri;
  service.saveSettings({ hijriAdjustment: 1 });
  const plus = service.getDay(DAY).hijri;
  assert.notEqual(base, plus);
  assert.match(base, /23/);
  assert.match(plus, /24/);
});

// ---- Form preview --------------------------------------------------------------------------------------------
test('Preview: fixed time shows end time, zone note and no errors', () => {
  const { service } = makeService();
  const p = service.previewForm(form({ start: fixed('23:30'), durationMinutes: 90 }));
  assert.deepEqual(p.errors, []);
  assert.equal(p.resolved.startLabel, '11:30 PM');
  assert.equal(p.resolved.endLabel, '1:00 AM');
  assert.equal(p.resolved.endsNextDay, true);
  assert.equal(p.placement.zoneName, 'Isha → Fajr');
});

test('Preview: prayer-relative start is resolved for the chosen date', () => {
  const { service } = makeService();
  const p = service.previewForm(form({ start: { mode: 'prayer', prayer: 'asr', direction: 'after', minutes: 10 } }));
  assert.equal(p.resolved.startLabel, '3:24 PM');
  assert.equal(p.placement.zoneName, 'Asr → Maghrib');
});

test('Preview: a task at 2:00 AM tells the user which Planning Day it will appear under', () => {
  const { service } = makeService();
  const p = service.previewForm(form({ start: fixed('02:00'), date: '2026-10-05' }));
  assert.equal(p.placement.differsFromDate, true);
  assert.equal(p.placement.text, 'Will appear under Planning Day: Oct 4 → Oct 5, Zone: Isha → Fajr');
});

test('Preview: repeat summary and the next 5 dates; friendly errors', () => {
  const { service } = makeService();
  const p = service.previewForm(fridayForm());
  assert.equal(p.rule.summary, 'Every Friday, starting Oct 2');
  assert.equal(p.rule.preview.length, 5);
  assert.deepEqual(p.rule.preview[0], { key: '2026-10-02', label: 'Fri, Oct 2, 2026' });

  const bad = service.previewForm(form({ durationMinutes: 0, start: fixed('99:99') }));
  assert.ok(bad.errors.length >= 2);
  assert.equal(bad.resolved, null);
  assert.ok(service.previewForm(form({ date: '' })).errors.some((e) => /date/i.test(e)));
});

// ---- Saving, scopes, deleting -----------------------------------------------------------------------------------------
test('Editing a one-off task', () => {
  const { service } = makeService();
  const { taskId } = service.saveTask({ mode: 'create', form: form() });
  const edit = service.getTaskForEdit({ taskId, dateKey: DAY });
  assert.equal(edit.isRecurring, false);
  assert.equal(edit.form.title, 'Study SQL');
  service.saveTask({
    mode: 'edit', taskId, dateKey: DAY,
    form: { ...edit.form, title: 'Study SQL joins', start: fixed('13:00'), date: '2026-10-06' },
  });
  assert.equal(service.getDay(DAY).zones.flatMap((z) => z.tasks).length, 0);
  assert.deepEqual(titlesOf(service.getDay('2026-10-06'), 2), ['Study SQL joins']);
});

test('Saving rejects bad input with a friendly message', () => {
  const { service } = makeService();
  assert.throws(() => service.saveTask({ mode: 'create', form: form({ title: '  ' }) }), /title/i);
  assert.throws(() => service.saveTask({ mode: 'create', form: form({ durationMinutes: -5 }) }), /Duration/);
  assert.throws(() => service.saveTask({ mode: 'edit', taskId: 'ghost', dateKey: DAY, scope: 'all', form: form() }), /no longer exists/);
});

test('Recurring: "This occurrence only" changes just that day', () => {
  const { service } = makeService();
  const { taskId } = service.saveTask({ mode: 'create', form: fridayForm() });
  const edit = service.getTaskForEdit({ taskId, dateKey: '2026-10-09' });
  assert.equal(edit.isRecurring, true);
  service.saveTask({
    mode: 'edit', taskId, dateKey: '2026-10-09', scope: 'this',
    form: { ...edit.form, start: fixed('08:00'), notes: 'light' },
  });
  assert.equal(service.getDay('2026-10-09').zones[0].tasks[0].startLabel, '8:00 AM');
  assert.equal(service.getDay('2026-10-16').zones[0].tasks[0].startLabel, '9:00 AM');
  assert.equal(service.getDay('2026-10-02').zones[0].tasks[0].startLabel, '9:00 AM');
});

test('Recurring: "All occurrences" changes the base but keeps unrelated single edits', () => {
  const { service } = makeService();
  const { taskId } = service.saveTask({ mode: 'create', form: fridayForm() });
  const e1 = service.getTaskForEdit({ taskId, dateKey: '2026-10-09' });
  service.saveTask({ mode: 'edit', taskId, dateKey: '2026-10-09', scope: 'this', form: { ...e1.form, start: fixed('08:00') } });

  // Change only the title for all occurrences, starting from the edited occurrence
  const e2 = service.getTaskForEdit({ taskId, dateKey: '2026-10-09' });
  service.saveTask({ mode: 'edit', taskId, dateKey: '2026-10-09', scope: 'all', form: { ...e2.form, title: 'Gym session' } });

  assert.equal(service.getDay('2026-10-09').zones[0].tasks[0].title, 'Gym session');
  assert.equal(service.getDay('2026-10-09').zones[0].tasks[0].startLabel, '8:00 AM', 'single edit of the time survives');
  assert.equal(service.getDay('2026-10-16').zones[0].tasks[0].title, 'Gym session');
  assert.equal(service.getDay('2026-10-16').zones[0].tasks[0].startLabel, '9:00 AM');
});

test('Recurring: "This and following" splits the task and keeps history', () => {
  const { service } = makeService();
  const { taskId } = service.saveTask({ mode: 'create', form: fridayForm() });
  service.setDone({ taskId, dateKey: '2026-10-02', done: true });

  const edit = service.getTaskForEdit({ taskId, dateKey: '2026-10-16' });
  service.saveTask({
    mode: 'edit', taskId, dateKey: '2026-10-16', scope: 'following',
    form: { ...edit.form, start: fixed('10:00') },
  });
  assert.equal(service.data.tasks.length, 2);
  assert.equal(service.getDay('2026-10-09').zones[0].tasks[0].startLabel, '9:00 AM');
  assert.equal(service.getDay('2026-10-16').zones[0].tasks[0].startLabel, '10:00 AM');
  assert.equal(service.getDay('2026-10-23').zones[0].tasks[0].startLabel, '10:00 AM');
  assert.equal(service.getDay('2026-10-02').zones[0].tasks[0].done, true);
});

test('Recurring: changing the repeat pattern for one occurrence only is refused', () => {
  const { service } = makeService();
  const { taskId } = service.saveTask({ mode: 'create', form: fridayForm() });
  const edit = service.getTaskForEdit({ taskId, dateKey: '2026-10-09' });
  const changed = { ...edit.form, recurrence: { ...edit.form.recurrence, interval: 2 } };
  assert.throws(
    () => service.saveTask({ mode: 'edit', taskId, dateKey: '2026-10-09', scope: 'this', form: changed }),
    /repeat pattern/
  );
  service.saveTask({ mode: 'edit', taskId, dateKey: '2026-10-09', scope: 'all', form: changed });
  assert.equal(service.getDay('2026-10-09').zones[0].tasks.length, 0, 'every 2 weeks from Oct 2 skips Oct 9');
  assert.equal(service.getDay('2026-10-16').zones[0].tasks.length, 1);
});

test('Saving without changes does nothing', () => {
  const { service, store } = makeService();
  const { taskId } = service.saveTask({ mode: 'create', form: fridayForm() });
  const saves = store.saveCount;
  const edit = service.getTaskForEdit({ taskId, dateKey: '2026-10-09' });
  const result = service.saveTask({ mode: 'edit', taskId, dateKey: '2026-10-09', scope: 'all', form: edit.form });
  assert.equal(result.unchanged, true);
  assert.equal(store.saveCount, saves);
});

test('Switching between one-off and repeating', () => {
  const { service } = makeService();
  const { taskId } = service.saveTask({ mode: 'create', form: form() });
  const edit = service.getTaskForEdit({ taskId, dateKey: DAY });
  const repeating = {
    ...edit.form,
    recurrence: { startDate: DAY, frequency: 'daily', interval: 1 },
  };
  assert.throws(() => service.saveTask({ mode: 'edit', taskId, dateKey: DAY, scope: 'this', form: repeating }), /All occurrences/);
  service.saveTask({ mode: 'edit', taskId, dateKey: DAY, scope: 'all', form: repeating });
  assert.equal(service.getDay('2026-10-07').zones[0].tasks.length, 1);
  assert.equal(service.data.tasks.length, 1);
});

test('Deleting: this / following / all', () => {
  const { service } = makeService();
  const { taskId } = service.saveTask({ mode: 'create', form: fridayForm() });
  service.deleteTask({ taskId, dateKey: '2026-10-09', scope: 'this' });
  assert.equal(service.getDay('2026-10-09').zones[0].tasks.length, 0);
  assert.equal(service.getDay('2026-10-16').zones[0].tasks.length, 1);

  service.deleteTask({ taskId, dateKey: '2026-10-23', scope: 'following' });
  assert.equal(service.getDay('2026-10-16').zones[0].tasks.length, 1);
  assert.equal(service.getDay('2026-10-23').zones[0].tasks.length, 0);

  service.deleteTask({ taskId, dateKey: '2026-10-02', scope: 'all' });
  assert.equal(service.data.tasks.length, 0);
});

test('Duplicate makes an independent copy', () => {
  const { service } = makeService();
  const { taskId } = service.saveTask({ mode: 'create', form: form() });
  service.setDone({ taskId, dateKey: DAY, done: true });
  const copyResult = service.duplicateTask({ taskId });
  const rows = service.getDay(DAY).zones[0].tasks;
  assert.deepEqual(rows.map((r) => r.title).sort(), ['Study SQL', 'Study SQL (copy)']);
  assert.equal(rows.find((r) => r.taskId === copyResult.taskId).done, false);
});

test('Every change tells the window to refresh', () => {
  const { service, calls } = makeService();
  const before = calls.dataChanged;
  const { taskId } = service.saveTask({ mode: 'create', form: form() });
  service.setDone({ taskId, dateKey: DAY, done: true });
  assert.equal(calls.dataChanged - before, 2);
});

test('Arabic titles are saved and returned unchanged', () => {
  const { service } = makeService();
  service.saveTask({ mode: 'create', form: form({ title: 'مراجعة الدرس', notes: 'ملاحظات' }) });
  const row = service.getDay(DAY).zones[0].tasks[0];
  assert.equal(row.title, 'مراجعة الدرس');
  assert.equal(row.notes, 'ملاحظات');
});

// ---- Settings and categories ----------------------------------------------------------------------------------------------
test('Settings: changes are validated, saved, and rebuild the prayer times', () => {
  const { service, calls } = makeService();
  service.getDay(DAY);
  const builds = calls.providerBuilds;
  service.getDay(DAY);
  assert.equal(calls.providerBuilds, builds, 'prayer times are reused');

  const saved = service.saveSettings({ adjustments: { asr: 5 }, theme: 'dark' });
  assert.equal(saved.adjustments.asr, 5);
  assert.equal(saved.adjustments.fajr, 0, 'other prayers keep their adjustment');
  assert.equal(saved.theme, 'dark');
  service.getDay(DAY);
  assert.equal(calls.providerBuilds, builds + 1, 'prayer times are rebuilt after a change');
  assert.equal(calls.settingsChanged.length, 1);

  assert.throws(() => service.saveSettings({ theme: 'pink' }), /Theme/);
  assert.throws(() => service.saveSettings({ cityName: 'Paris' }), /city/);
  assert.throws(() => service.saveSettings({ adjustments: { fajr: 500 } }), /adjustment/);
  assert.throws(() => service.saveSettings({ workingDays: [] }), /working day/);
  assert.equal(service.getSettings().theme, 'dark', 'bad input changed nothing');
});

test('Working days change "last working day" rules', () => {
  const { service } = makeService();
  service.saveTask({
    mode: 'create',
    form: form({
      title: 'Month end',
      date: undefined,
      recurrence: { startDate: '2026-10-01', frequency: 'monthly', interval: 1, monthly: { type: 'lastWorkingDay' } },
    }),
  });
  assert.equal(service.getDay('2026-10-29').zones.flatMap((z) => z.tasks).length, 1, 'Thursday (Sun-Thu week)');
  service.saveSettings({ workingDays: [1, 2, 3, 4, 5] });
  assert.equal(service.getDay('2026-10-29').zones.flatMap((z) => z.tasks).length, 0);
  assert.equal(service.getDay('2026-10-30').zones.flatMap((z) => z.tasks).length, 1, 'Friday (Mon-Fri week)');
});

test('Categories: add, rename, recolor, delete (tasks become uncategorized)', () => {
  const { service } = makeService();
  const added = service.addCategory({ name: ' Family ', color: '#112233' });
  assert.equal(added.length, 6);
  const family = added.find((c) => c.name === 'Family');

  assert.throws(() => service.addCategory({ name: 'family', color: '#112233' }), /already/);
  assert.throws(() => service.addCategory({ name: '', color: '#112233' }), /name/);
  assert.throws(() => service.addCategory({ name: 'X', color: 'red' }), /color/);

  const { taskId } = service.saveTask({ mode: 'create', form: form({ categoryId: family.id }) });
  assert.equal(service.getDay(DAY).zones[0].tasks[0].categoryName, 'Family');

  service.updateCategory({ id: family.id, name: 'Home', color: '#445566' });
  const row = service.getDay(DAY).zones[0].tasks[0];
  assert.equal(row.categoryName, 'Home');
  assert.equal(row.categoryColor, '#445566');

  service.deleteCategory({ id: family.id });
  assert.equal(service.data.categories.length, 5);
  assert.equal(service.getDay(DAY).zones[0].tasks[0].categoryName, '');
  assert.equal(service.data.tasks.length, 1, 'the task is not deleted');
  assert.equal(service.findTask(taskId).categoryId, null);
});

test('Upcoming reminders for the bell', () => {
  const { service } = makeService({ now: at(DAY, '07:00') });
  service.saveTask({ mode: 'create', form: form({ reminders: { enabled: true, offsets: [15, 0] } }) });
  const list = service.getUpcoming();
  assert.deepEqual(list.map((r) => r.whenLabel), ['Today, 7:45 AM', 'Today, 8:00 AM']);
  assert.equal(list[0].title, 'Study SQL');
});

// ---- Export / import ------------------------------------------------------------------------------------------------------------
test('Export then import restores everything', () => {
  const a = makeService();
  const { taskId } = a.service.saveTask({ mode: 'create', form: fridayForm({ categoryId: 'cat-health' }) });
  a.service.setDone({ taskId, dateKey: '2026-10-02', done: true });
  a.service.deleteTask({ taskId, dateKey: '2026-10-09', scope: 'this' });
  a.service.saveSettings({ theme: 'dark', adjustments: { isha: -3 } });
  a.service.addCategory({ name: 'Family', color: '#112233' });

  const backup = a.service.exportData();
  assert.equal(backup.app, 'daily-planner');
  assert.equal(backup.formatVersion, 1);
  assert.ok(!('reminderState' in backup));
  const text = JSON.stringify(backup);

  const b = makeService();
  const result = b.service.importData(text);
  assert.equal(result.tasks, 1);
  assert.equal(result.categories, 6);
  assert.deepEqual(result.warnings, []);
  assert.equal(b.service.getSettings().theme, 'dark');
  assert.equal(b.service.getSettings().adjustments.isha, -3);
  assert.equal(b.service.getDay('2026-10-02').zones[0].tasks[0].done, true);
  assert.equal(b.service.getDay('2026-10-09').zones[0].tasks.length, 0);
  assert.equal(b.service.getDay('2026-10-16').zones[0].tasks[0].categoryName, 'Health');
  assert.equal(b.calls.settingsChanged.length, 1);
});

test('Import refuses files that are not backups, or are from a newer version', () => {
  const { service } = makeService();
  assert.throws(() => service.importData('not json at all'), /not a Daily Planner backup/);
  assert.throws(() => service.importData('{"hello": 1}'), /not a Daily Planner backup/);
  assert.throws(() => service.importData({ app: 'daily-planner', formatVersion: 99 }), /newer version/);
  assert.throws(() => service.importData({ app: 'daily-planner' }), /version/);
  assert.equal(service.data.tasks.length, 0);
});

test('Import skips damaged tasks and tells the user, keeping the rest', () => {
  const { service } = makeService();
  const good = makeService();
  good.service.saveTask({ mode: 'create', form: form({ title: 'Good one' }) });
  const backup = good.service.exportData();
  backup.tasks.push({ id: 'bad', title: '', start: fixed('08:00'), durationMinutes: 30, date: DAY });
  backup.tasks.push({ ...backup.tasks[0] }); // same id twice
  backup.categories.push({ id: 'x', name: '', color: 'nope' });
  const result = service.importData(backup);
  assert.equal(result.tasks, 1);
  assert.equal(result.warnings.length, 3);
  assert.ok(result.warnings.some((w) => /twice/.test(w)));
});

test('Importing keeps internal reminder bookkeeping', () => {
  const { service } = makeService();
  service.saveReminderState({ delivered: { a: 1 }, lastTickAt: 5, snoozed: [] });
  service.importData(buildExport(emptyData()));
  assert.equal(service.getReminderState().lastTickAt, 5);
});

test('Only known methods can be called from the window', () => {
  assert.ok(PUBLIC_METHODS.includes('getDay'));
  assert.ok(!PUBLIC_METHODS.includes('importData'), 'import goes through the file dialog, not directly');
  assert.ok(!PUBLIC_METHODS.includes('persist'));
  for (const name of PUBLIC_METHODS) assert.equal(typeof PlannerService.prototype[name], 'function', name);
});

// ---- File storage --------------------------------------------------------------------------------------------------------------------
function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-test-'));
  return { dir, file: path.join(dir, 'data.json') };
}

test('File store: first run gives fresh data; save then load round-trips', () => {
  const { dir, file } = tempFile();
  const store = new FileStore(file);
  const fresh = store.load();
  assert.deepEqual(fresh.categories, defaultCategories());
  assert.equal(fresh.tasks.length, 0);

  const { service } = makeService({ store });
  service.saveTask({ mode: 'create', form: form() });
  assert.ok(fs.existsSync(file));
  assert.ok(!fs.existsSync(`${file}.tmp`), 'no temporary file is left behind');

  const reloaded = new FileStore(file).load();
  assert.equal(reloaded.tasks.length, 1);
  assert.equal(reloaded.tasks[0].title, 'Study SQL');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('File store: a backup copy is kept, and a damaged file falls back to it', () => {
  const { dir, file } = tempFile();
  const store = new FileStore(file);
  const data = emptyData();
  store.save(data);
  data.tasks.push(normalizeData({ tasks: [{ id: 'a', title: 'First', start: fixed('08:00'), durationMinutes: 30, date: DAY }] }).data.tasks[0]);
  store.save(data);
  assert.ok(fs.existsSync(`${file}.bak`));

  fs.writeFileSync(file, '{ this is damaged'); // power cut in the middle of a write, for example
  const fresh = new FileStore(file);
  const loaded = fresh.load();
  assert.equal(loaded.tasks.length, 0, 'the older backup copy was used');
  assert.ok(fresh.loadNotes.some((n) => /backup/.test(n)));
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('data.json.damaged-')), 'the damaged file is kept aside');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('File store: unreadable file and no backup starts empty with a note', () => {
  const { dir, file } = tempFile();
  fs.writeFileSync(file, 'garbage');
  const store = new FileStore(file);
  const loaded = store.load();
  assert.equal(loaded.tasks.length, 0);
  assert.ok(store.loadNotes.length > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Loading cleans old or damaged data instead of crashing', () => {
  const { dir, file } = tempFile();
  fs.writeFileSync(file, JSON.stringify({
    settings: { theme: 'purple', cityName: 'Alexandria' },
    categories: 'oops',
    tasks: [{ id: 't', title: 'Fine', start: fixed('08:00'), durationMinutes: 30, date: DAY, categoryId: 'ghost' }, 5, null],
  }));
  const store = new FileStore(file);
  const loaded = store.load();
  assert.equal(loaded.settings.theme, 'system', 'invalid value replaced by the default');
  assert.equal(loaded.settings.cityName, 'Alexandria', 'valid value kept');
  assert.equal(loaded.categories.length, 5);
  assert.equal(loaded.tasks.length, 1);
  assert.equal(loaded.tasks[0].categoryId, null, 'category that does not exist is cleared');
  assert.equal(loaded.tasks[0].priority, 'Medium');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('parseImport accepts a plain object too', () => {
  const { data } = parseImport(buildExport(emptyData()));
  assert.equal(data.categories.length, 5);
});
