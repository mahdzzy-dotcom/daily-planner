'use strict';

// The settings of the full-screen reminder, and how the service passes them on.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_SETTINGS, DEFAULT_ALERT_APPEARANCE, ALERT_PRESETS, ALERT_FONTS, validateSettings, validateAppearance,
  mergeSettings, sanitizeSettings, normalizeData, buildExport, parseImport, emptyData,
} = require('../src/core');
const { PlannerService } = require('../src/main/service');
const { MemoryStore } = require('../src/main/store');
const { at, constantProvider } = require('./helpers');

const DAY = '2026-10-04';

function makeService() {
  let n = 0;
  return new PlannerService({
    store: new MemoryStore(),
    now: () => at(DAY, '10:00'),
    newId: () => `id${++n}`,
    providerFactory: () => constantProvider,
  });
}

function form(extra = {}) {
  return {
    title: 'Study', notes: 'Chapter 4', start: { mode: 'fixed', time: '12:00' }, durationMinutes: 45, date: DAY, recurrence: null,
    reminders: { enabled: false, offsets: [], fullScreen: true }, priority: 'High', categoryId: 'cat-study', ...extra,
  };
}

test('Defaults: alerts allowed, off for new tasks, all screens, a dark readable look', () => {
  assert.equal(DEFAULT_SETTINGS.fullScreenAlerts, true);
  assert.equal(DEFAULT_SETTINGS.fullScreenDefaultForNewTasks, false);
  assert.equal(DEFAULT_SETTINGS.alertScreens, 'all');
  assert.deepEqual(validateSettings(DEFAULT_SETTINGS), []);
  assert.deepEqual(DEFAULT_SETTINGS.alertAppearance, DEFAULT_ALERT_APPEARANCE);
});

test('Every ready-made look is complete and valid', () => {
  assert.deepEqual(Object.keys(ALERT_PRESETS).sort(), ['calm', 'dark', 'highContrast', 'light', 'red']);
  for (const [key, preset] of Object.entries(ALERT_PRESETS)) {
    assert.deepEqual(validateAppearance(preset.appearance), [], key);
    // complete: cleaning it changes nothing
    const full = mergeSettings(DEFAULT_SETTINGS, { alertAppearance: preset.appearance }).alertAppearance;
    assert.deepEqual(full, preset.appearance, key);
    assert.ok(preset.label);
  }
});

test('Validation: colors, sizes, fonts, yes/no values, unknown options', () => {
  const bad = (patch) => validateAppearance(patch);
  assert.ok(bad({ backgroundColor: 'red' }).length);
  assert.ok(bad({ backgroundColor: '#12345' }).length);
  assert.ok(bad({ textColor: '#GGGGGG' }).length);
  assert.ok(bad({ name: { size: 23 } }).length);
  assert.ok(bad({ name: { size: 161 } }).length);
  assert.ok(bad({ name: { size: 80.5 } }).length);
  assert.ok(bad({ notes: { size: 13 } }).length);
  assert.ok(bad({ notes: { size: 97 } }).length);
  assert.ok(bad({ fontFamily: 'Comic Sans' }).length);
  assert.ok(bad({ alignment: 'right' }).length);
  assert.ok(bad({ name: { bold: 'yes' } }).length);
  assert.ok(bad({ show: { zone: 1 } }).length);
  assert.ok(bad({ nonsense: true }).length);
  assert.ok(bad({ name: { shadow: true } }).length);
  assert.ok(bad('dark').length);
  assert.ok(bad(null).length);
  assert.deepEqual(bad({ name: { size: 24 }, notes: { size: 96 }, fontFamily: ALERT_FONTS[2], alignment: 'left' }), []);
  assert.ok(validateSettings({ alertScreens: 'third' }).length);
  assert.ok(validateSettings({ fullScreenAlerts: 'yes' }).length);
});

test('Merging changes only what was sent, and never touches the old settings', () => {
  const before = JSON.stringify(DEFAULT_SETTINGS);
  const merged = mergeSettings(DEFAULT_SETTINGS, { alertAppearance: { backgroundColor: '#112233', name: { size: 100 }, show: { zone: false } } });
  assert.equal(merged.alertAppearance.backgroundColor, '#112233');
  assert.equal(merged.alertAppearance.name.size, 100);
  assert.equal(merged.alertAppearance.name.color, DEFAULT_ALERT_APPEARANCE.name.color, 'neighbours stay');
  assert.equal(merged.alertAppearance.name.bold, true);
  assert.equal(merged.alertAppearance.show.zone, false);
  assert.equal(merged.alertAppearance.show.time, true);
  assert.equal(merged.alertAppearance.notes.size, 34);
  assert.equal(JSON.stringify(DEFAULT_SETTINGS), before);
  assert.throws(() => mergeSettings(DEFAULT_SETTINGS, { alertAppearance: { name: { size: 500 } } }), /not a valid value/);
});

test('Loading old or damaged settings keeps the good parts and defaults the rest', () => {
  const old = sanitizeSettings({ theme: 'dark' }); // saved before this feature existed
  assert.deepEqual(old.alertAppearance, DEFAULT_ALERT_APPEARANCE);
  assert.equal(old.fullScreenAlerts, true);
  assert.equal(old.theme, 'dark');

  const mixed = sanitizeSettings({
    alertAppearance: { backgroundColor: '#abcdef', name: { size: 'huge', bold: false }, notes: 'oops', show: { zone: false } },
    alertScreens: 'nowhere',
    fullScreenDefaultForNewTasks: true,
  });
  assert.equal(mixed.alertAppearance.backgroundColor, '#abcdef');
  assert.equal(mixed.alertAppearance.name.size, 80, 'bad value replaced');
  assert.equal(mixed.alertAppearance.name.bold, false, 'good value kept');
  assert.deepEqual(mixed.alertAppearance.notes, DEFAULT_ALERT_APPEARANCE.notes);
  assert.equal(mixed.alertAppearance.show.zone, false);
  assert.equal(mixed.alertScreens, 'all');
  assert.equal(mixed.fullScreenDefaultForNewTasks, true);
});

test('Backups keep the look, the switches and each task\'s full-screen switch', () => {
  const service = makeService();
  service.saveSettings({ fullScreenDefaultForNewTasks: true, alertScreens: 'main', alertAppearance: { backgroundColor: '#010203' } });
  service.saveTask({ mode: 'create', form: form() });
  const text = JSON.stringify(service.exportData());

  const other = makeService();
  const result = other.importData(text);
  assert.deepEqual(result.warnings, []);
  assert.equal(other.getSettings().alertAppearance.backgroundColor, '#010203');
  assert.equal(other.getSettings().alertScreens, 'main');
  assert.equal(other.getSettings().fullScreenDefaultForNewTasks, true);
  assert.equal(other.data.tasks[0].reminders.fullScreen, true);

  // A backup made before this feature loads fine, with the new settings at their defaults
  const older = JSON.parse(text);
  delete older.settings.alertAppearance; delete older.settings.alertScreens; delete older.settings.fullScreenAlerts;
  delete older.tasks[0].reminders.fullScreen;
  const { data, warnings } = parseImport(older);
  assert.deepEqual(warnings, []);
  assert.deepEqual(data.settings.alertAppearance, DEFAULT_ALERT_APPEARANCE);
  assert.equal(data.tasks[0].reminders.fullScreen, undefined);
  assert.deepEqual(normalizeData(buildExport(emptyData())).warnings, []);
});

test('Service: alert payload, config, presets and the sample', () => {
  const service = makeService();
  const { taskId } = service.saveTask({ mode: 'create', form: form() });
  const [occ] = service.getDay(DAY).zones[1].tasks;
  assert.equal(occ.hasFullScreen, true);
  assert.equal(occ.taskId, taskId);

  const items = service.buildAlertItems([{
    id: 'x', taskId, dateKey: DAY, title: 'Study', notes: 'Chapter 4', priority: 'High', categoryId: 'cat-study',
    durationMinutes: 45, start: at(DAY, '12:00'), end: at(DAY, '12:45'), zoneName: 'Dhuhr → Asr', zoneIndex: 2,
  }]);
  assert.deepEqual(items[0], {
    id: 'x', taskId, dateKey: DAY, title: 'Study', notes: 'Chapter 4', startLabel: '12:00 PM', endLabel: '12:45 PM',
    durationLabel: '45m', zoneName: 'Dhuhr → Asr', zoneIndex: 2, categoryName: 'Study', categoryColor: '#8b5cf6',
    priority: 'High', snoozed: false,
  });

  const config = service.getAlertConfig();
  assert.equal(config.screens, 'all');
  assert.equal(config.snoozeMinutes, 5);
  assert.deepEqual(config.appearance, DEFAULT_ALERT_APPEARANCE);
  config.appearance.backgroundColor = '#000000';
  assert.equal(service.getSettings().alertAppearance.backgroundColor, '#0f172a', 'a copy, not the real settings');

  assert.deepEqual(service.getAlertPreset('highContrast'), ALERT_PRESETS.highContrast.appearance);
  assert.throws(() => service.getAlertPreset('neon'), /does not exist/);
  const sample = service.getAlertSample();
  assert.equal(sample.taskId, '__sample__');
  assert.ok(sample.title && sample.notes.includes('\n'));
});

test('Service: the task switch is saved, can differ per occurrence, and defaults come from Settings', () => {
  const service = makeService();
  assert.equal(service.newTaskDefaults(DAY).reminders.fullScreen, false);
  service.saveSettings({ fullScreenDefaultForNewTasks: true });
  assert.equal(service.newTaskDefaults(DAY).reminders.fullScreen, true);

  const repeating = { startDate: '2026-10-01', frequency: 'daily', interval: 1 };
  const { taskId } = service.saveTask({ mode: 'create', form: form({ recurrence: repeating }) });
  const edit = service.getTaskForEdit({ taskId, dateKey: '2026-10-06' });
  assert.equal(edit.form.reminders.fullScreen, true);
  service.saveTask({
    mode: 'edit', taskId, dateKey: '2026-10-06', scope: 'this',
    form: { ...edit.form, reminders: { ...edit.form.reminders, fullScreen: false } },
  });
  const has = (key) => service.getDay(key).zones.flatMap((z) => z.tasks)[0].hasFullScreen;
  assert.equal(has('2026-10-05'), true);
  assert.equal(has('2026-10-06'), false, 'switched off for that one day');
  assert.equal(has('2026-10-07'), true);
});
