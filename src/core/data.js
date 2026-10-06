'use strict';

// The saved data and the export/import file format.
//
// Saved data (data.json in the user's profile folder):
//   { version, settings, categories, tasks, reminderState }
//
// Export file (documented in docs/DATA_FORMAT.md):
//   { app: 'daily-planner', formatVersion: 1, exportedAt, settings, categories, tasks }
//
// Derived values (zones, end times, durations, occurrences, prayer times) are never saved.

const { DEFAULT_SETTINGS, sanitizeSettings } = require('./settings');
const { validateTask } = require('./tasks');
const { normalizeRule } = require('./recurrence');
const { emptyState } = require('./reminder-engine');

const APP_NAME = 'daily-planner';
const FORMAT_VERSION = 1;
const DATA_VERSION = 1;

function defaultCategories() {
  return [
    { id: 'cat-work', name: 'Work', color: '#3b82f6' },
    { id: 'cat-study', name: 'Study', color: '#8b5cf6' },
    { id: 'cat-worship', name: 'Worship', color: '#10b981' },
    { id: 'cat-personal', name: 'Personal', color: '#f59e0b' },
    { id: 'cat-health', name: 'Health', color: '#ef4444' },
  ];
}

function emptyData() {
  return {
    version: DATA_VERSION,
    settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
    categories: defaultCategories(),
    tasks: [],
    reminderState: emptyState(),
  };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function normalizeCategories(raw, warnings) {
  if (!Array.isArray(raw)) return defaultCategories();
  const seen = new Set();
  const result = [];
  for (const c of raw) {
    const valid =
      isPlainObject(c) &&
      typeof c.id === 'string' && c.id !== '' &&
      typeof c.name === 'string' && c.name.trim() !== '' &&
      typeof c.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(c.color);
    if (!valid || seen.has(c.id)) {
      warnings.push('A category was skipped because it was not valid');
      continue;
    }
    seen.add(c.id);
    result.push({ id: c.id, name: c.name.trim(), color: c.color });
  }
  return result;
}

// Make a task read from a file safe to use: fill missing fields, then validate it.
function normalizeTask(raw) {
  if (!isPlainObject(raw)) return { error: 'not a task' };
  const task = {
    id: raw.id,
    title: typeof raw.title === 'string' ? raw.title.trim() : raw.title,
    start: raw.start,
    durationMinutes: raw.durationMinutes,
    date: raw.recurrence ? null : raw.date,
    recurrence: isPlainObject(raw.recurrence) ? normalizeRule(raw.recurrence) : null,
    reminders: isPlainObject(raw.reminders) ? raw.reminders : { enabled: false, offsets: [] },
    priority: raw.priority || 'Medium',
    categoryId: raw.categoryId === undefined ? null : raw.categoryId,
    notes: typeof raw.notes === 'string' ? raw.notes : '',
    exceptions: Array.isArray(raw.exceptions) ? raw.exceptions.filter((k) => typeof k === 'string') : [],
    additions: Array.isArray(raw.additions) ? raw.additions.filter((k) => typeof k === 'string') : [],
    overrides: isPlainObject(raw.overrides) ? raw.overrides : {},
    completions: isPlainObject(raw.completions) ? raw.completions : {},
  };
  const errors = validateTask(task);
  return errors.length ? { error: errors.join('; ') } : { task };
}

// Clean up a whole data object (from disk or an import file).
// Returns { data, warnings }. Never throws for individual bad items; they are skipped and reported.
function normalizeData(raw) {
  const warnings = [];
  const source = isPlainObject(raw) ? raw : {};
  const settings = sanitizeSettings(source.settings);
  const categories = normalizeCategories(source.categories, warnings);

  const categoryIds = new Set(categories.map((c) => c.id));
  const tasks = [];
  const ids = new Set();
  for (const rawTask of Array.isArray(source.tasks) ? source.tasks : []) {
    const { task, error } = normalizeTask(rawTask);
    const label = isPlainObject(rawTask) && rawTask.title ? `"${rawTask.title}"` : 'A task';
    if (error) {
      warnings.push(`${label} was skipped: ${error}`);
      continue;
    }
    if (ids.has(task.id)) {
      warnings.push(`${label} was skipped because its id is used twice`);
      continue;
    }
    ids.add(task.id);
    if (task.categoryId !== null && !categoryIds.has(task.categoryId)) task.categoryId = null;
    tasks.push(task);
  }

  const reminderState = isPlainObject(source.reminderState)
    ? { ...emptyState(), ...source.reminderState }
    : emptyState();

  return {
    data: { version: DATA_VERSION, settings, categories, tasks, reminderState },
    warnings,
  };
}

function buildExport(data, now = new Date()) {
  return {
    app: APP_NAME,
    formatVersion: FORMAT_VERSION,
    exportedAt: now.toISOString(),
    settings: data.settings,
    categories: data.categories,
    tasks: data.tasks,
  };
}

// Reads text (or an already-parsed object) from an export file.
// Returns { data, warnings } or throws an Error with a friendly message.
function parseImport(input) {
  let parsed = input;
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input);
    } catch (error) {
      throw new Error('This file is not a Daily Planner backup (it could not be read).');
    }
  }
  if (!isPlainObject(parsed) || parsed.app !== APP_NAME) {
    throw new Error('This file is not a Daily Planner backup.');
  }
  if (!Number.isInteger(parsed.formatVersion) || parsed.formatVersion < 1) {
    throw new Error('This backup file has no valid version number.');
  }
  if (parsed.formatVersion > FORMAT_VERSION) {
    throw new Error('This backup was made by a newer version of Daily Planner. Please update the app first.');
  }
  // Future versions: convert older formats here, one step at a time.
  return normalizeData(parsed);
}

module.exports = {
  APP_NAME,
  FORMAT_VERSION,
  DATA_VERSION,
  defaultCategories,
  emptyData,
  normalizeData,
  buildExport,
  parseImport,
};
