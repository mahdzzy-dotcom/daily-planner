'use strict';

// Checks the Electron main process wiring without Electron: a stand-in "electron" (and a stand-in
// prayer library) are supplied, so window creation, saved data, IPC, export/import and the
// notification-button links can all be exercised here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const MAIN_PATH = require.resolve('../src/main/main.js');

// ---- Stand-ins ------------------------------------------------------------------------------------------

function makeFakeElectron({ userData, lock = true, saveTo, openFrom }) {
  const fake = {
    appId: null,
    quitCalled: false,
    appEvents: {},
    ipc: {},
    ipcOn: {},
    windows: [],
    notifications: [],
    dialogs: { saveTo, openFrom },
  };

  fake.app = {
    isPackaged: false,
    setAppUserModelId: (id) => { fake.appId = id; },
    requestSingleInstanceLock: () => lock,
    quit: () => { fake.quitCalled = true; },
    on: (event, fn) => { (fake.appEvents[event] = fake.appEvents[event] || []).push(fn); },
    whenReady: () => Promise.resolve(),
    getPath: () => userData,
    setAsDefaultProtocolClient: () => {},
  };

  fake.BrowserWindow = class {
    constructor(options) {
      this.options = options;
      this.sent = [];
      this.shown = 0;
      this.handlers = {};
      this.webContents = {
        send: (channel, payload) => this.sent.push([channel, payload]),
        setWindowOpenHandler: () => {},
        on: () => {},
      };
      fake.windows.push(this);
    }
    setMenuBarVisibility() {}
    loadFile(file) { this.file = file; }
    on(event, fn) { this.handlers[event] = fn; }
    isDestroyed() { return false; }
    isMinimized() { return false; }
    restore() {}
    show() { this.shown += 1; }
    focus() {}
  };

  fake.ipcMain = {
    handle: (channel, fn) => { fake.ipc[channel] = fn; },
    on: (channel, fn) => { fake.ipcOn[channel] = fn; },
  };

  fake.dialog = {
    showSaveDialog: async () => (fake.dialogs.saveTo ? { canceled: false, filePath: fake.dialogs.saveTo } : { canceled: true }),
    showOpenDialog: async () => (fake.dialogs.openFrom ? { canceled: false, filePaths: [fake.dialogs.openFrom] } : { canceled: true }),
  };

  fake.Notification = class {
    constructor(options) { this.options = options; this.shown = false; fake.notifications.push(this); }
    on() {}
    show() { this.shown = true; }
    static isSupported() { return true; }
  };
  return fake;
}

// A stand-in for the "adhan" library: same shape, fixed times (5:05, 11:48, 3:14, 6:00, 7:20) every day.
function makeFakeAdhan() {
  class PrayerTimes {
    constructor(coordinates, date) {
      const at = (h, m) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), h, m, 0, 0);
      this.fajr = at(5, 5);
      this.dhuhr = at(11, 48);
      this.asr = at(15, 14);
      this.maghrib = at(18, 0);
      this.isha = at(19, 20);
    }
  }
  const method = () => ({ adjustments: { fajr: 0, sunrise: 0, dhuhr: 0, asr: 0, maghrib: 0, isha: 0 }, madhab: null });
  const names = ['Egyptian', 'MuslimWorldLeague', 'Karachi', 'UmmAlQura', 'Dubai', 'Qatar', 'Kuwait', 'Singapore', 'Turkey', 'Tehran', 'NorthAmerica', 'MoonsightingCommittee'];
  return {
    Coordinates: class { constructor(lat, lng) { this.latitude = lat; this.longitude = lng; } },
    CalculationMethod: Object.fromEntries(names.map((n) => [n, method])),
    Madhab: { Shafi: 'shafi', Hanafi: 'hanafi' },
    PrayerTimes,
  };
}

// "electron" and "adhan" are replaced for the whole file (the prayer library is loaded later, on first use).
const stand = { electron: null, adhan: makeFakeAdhan() };
const originalLoad = Module._load;
Module._load = function patched(request, ...rest) {
  if (request === 'electron' && stand.electron) return stand.electron;
  if (request === 'adhan') return stand.adhan;
  return originalLoad.call(this, request, ...rest);
};
test.after(() => {
  Module._load = originalLoad;
});

async function launch(options = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-main-'));
  const fake = makeFakeElectron({ userData, ...options });
  stand.electron = fake;
  delete require.cache[MAIN_PATH];
  const mainModule = require(MAIN_PATH);
  await new Promise((resolve) => setImmediate(resolve)); // let app.whenReady().then(...) run
  fake.userData = userData;
  fake.main = mainModule;
  fake.svc = (method, ...args) => fake.ipc.svc({}, method, args);
  fake.dataFile = () => JSON.parse(fs.readFileSync(path.join(userData, 'data.json'), 'utf8'));
  fake.cleanup = () => {
    // stop the reminder engine's timer, otherwise the test process would never finish
    if (fake.appEvents['before-quit']) fake.appEvents['before-quit'][0]();
    fs.rmSync(userData, { recursive: true, force: true });
  };
  return fake;
}

function form(extra = {}) {
  return {
    title: 'Study', start: { mode: 'fixed', time: '23:00' }, durationMinutes: 30, date: '2030-01-10',
    recurrence: null, reminders: { enabled: true, offsets: [0] }, priority: 'Medium', categoryId: null, notes: '', ...extra,
  };
}

// ---- Tests ----------------------------------------------------------------------------------------------

test('Start-up: app id, one secure window showing our page', async () => {
  const app = await launch();
  assert.equal(app.appId, 'com.dailyplanner.app');
  assert.equal(app.windows.length, 1);
  const win = app.windows[0];
  assert.equal(win.options.webPreferences.contextIsolation, true);
  assert.equal(win.options.webPreferences.nodeIntegration, false);
  assert.equal(win.options.webPreferences.sandbox, true);
  assert.ok(win.file.endsWith(path.join('renderer', 'index.html')));
  assert.ok(fs.existsSync(win.file), 'the page exists');
  assert.ok(fs.existsSync(win.options.webPreferences.preload), 'the preload script exists');
  assert.ok(fs.existsSync(win.options.icon), 'the icon exists');
  assert.equal(app.appEvents['window-all-closed'].length, 1);
  app.cleanup();
});

test('The window can call planner actions, but only the allowed ones', async () => {
  const app = await launch();
  const boot = await app.svc('bootstrap');
  assert.equal(boot.settings.cityName, 'Cairo');
  assert.ok(boot.cities.length >= 28);
  assert.match(boot.currentPlanningDayKey, /^\d{4}-\d{2}-\d{2}$/);

  await assert.rejects(() => app.svc('importData', {}), /Unknown request/);
  await assert.rejects(() => app.svc('persist'), /Unknown request/);
  await assert.rejects(() => app.ipc.svc({}, 'constructor', []), /Unknown request/);
  app.cleanup();
});

test('Saving a task writes the data file in the user data folder, and tells the window', async () => {
  const app = await launch();
  app.ipcOn['renderer-ready']();
  await app.svc('saveTask', { mode: 'create', form: form() });
  const saved = app.dataFile();
  assert.equal(saved.tasks.length, 1);
  assert.equal(saved.tasks[0].title, 'Study');
  assert.ok(app.windows[0].sent.some(([channel]) => channel === 'data-changed'));
  app.cleanup();
});

test('Export writes a backup file; import restores it; cancelling does nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-files-'));
  const backupFile = path.join(dir, 'backup.json');

  const a = await launch({ saveTo: backupFile });
  await a.svc('saveTask', { mode: 'create', form: form({ title: 'Keep me' }) });
  const exported = await a.ipc['export-data']();
  assert.equal(exported.ok, true);
  const parsed = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
  assert.equal(parsed.app, 'daily-planner');
  assert.equal(parsed.tasks.length, 1);
  a.cleanup();

  const b = await launch({ openFrom: backupFile });
  const imported = await b.ipc['import-data']();
  assert.equal(imported.ok, true);
  assert.equal(imported.tasks, 1);
  assert.equal(b.dataFile().tasks[0].title, 'Keep me');
  b.cleanup();

  const c = await launch();
  assert.deepEqual(await c.ipc['export-data'](), { canceled: true });
  assert.deepEqual(await c.ipc['import-data'](), { canceled: true });
  c.cleanup();

  fs.writeFileSync(backupFile, 'this is not a backup');
  const d = await launch({ openFrom: backupFile });
  await assert.rejects(() => d.ipc['import-data'](), /not a Daily Planner backup/);
  d.cleanup();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Notification buttons: Mark as Done and Snooze act quietly, without showing the window', async () => {
  const app = await launch();
  const { taskId } = await app.svc('saveTask', { mode: 'create', form: form() });
  const shownBefore = app.windows[0].shown;

  app.appEvents['second-instance'][0]({}, ['Daily Planner.exe', `dailyplanner://snooze?task=${taskId}&date=2030-01-10`]);
  assert.equal(app.dataFile().reminderState.snoozed.length, 1);

  app.appEvents['second-instance'][0]({}, ['Daily Planner.exe', `dailyplanner://done?task=${taskId}&date=2030-01-10`]);
  const saved = app.dataFile();
  assert.equal(saved.tasks[0].completions['2030-01-10'], true);
  assert.equal(saved.reminderState.snoozed.length, 0, 'done cancels the snooze');
  assert.equal(app.windows[0].shown, shownBefore, 'the window was not brought up');
  app.cleanup();
});

test('Clicking a notification opens the window on that task; a plain second launch just shows the window', async () => {
  const app = await launch();
  const { taskId } = await app.svc('saveTask', { mode: 'create', form: form() });
  const win = app.windows[0];

  // The window is not ready yet: the request waits
  app.appEvents['second-instance'][0]({}, ['x.exe', `dailyplanner://open?task=${taskId}&date=2030-01-10`]);
  assert.ok(!win.sent.some(([c]) => c === 'open-task'));
  assert.equal(win.shown, 1);

  app.ipcOn['renderer-ready']();
  assert.deepEqual(win.sent.find(([c]) => c === 'open-task')[1], { taskId, dateKey: '2030-01-10' });

  app.appEvents['second-instance'][0]({}, ['x.exe']);
  assert.equal(win.shown, 2);
  app.cleanup();
});

test('A second copy of the app quits immediately and the first keeps running', async () => {
  const app = await launch({ lock: false });
  assert.equal(app.quitCalled, true);
  assert.equal(app.windows.length, 0);
  app.cleanup();
});

test('Closing the last window quits the app (until Milestone 5 adds the tray)', async () => {
  const app = await launch();
  app.appEvents['window-all-closed'][0]();
  assert.equal(app.quitCalled, true);
  app.appEvents['before-quit'][0](); // saves the reminder state
  assert.ok(app.dataFile().reminderState);
  app.cleanup();
});

test('The reminder engine starts with the app', async () => {
  const app = await launch();
  await app.svc('saveTask', { mode: 'create', form: form() });
  app.appEvents['before-quit'][0]();
  const state = app.dataFile().reminderState;
  assert.ok(state.lastTickAt > 0, 'the engine has checked at least once');
  app.cleanup();
});

test('The preload script exposes only the expected functions', () => {
  const sent = [];
  const exposed = {};
  stand.electron = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
    ipcRenderer: { invoke: (...args) => { sent.push(args); return Promise.resolve(); }, send: () => {}, on: () => {} },
  };
  delete require.cache[require.resolve('../src/main/preload.js')];
  require('../src/main/preload.js');
  assert.deepEqual(Object.keys(exposed.api).sort(), ['call', 'exportData', 'importData', 'on', 'ready']);
  exposed.api.call('getDay', '2030-01-10');
  assert.deepEqual(sent[0], ['svc', 'getDay', ['2030-01-10']]);
});
