'use strict';

// Checks the Electron main process wiring without Electron: a stand-in "electron" (and a stand-in
// prayer library) are supplied, so window, tray, background running, start with Windows, saved data,
// IPC, export/import and the notification-button links can all be exercised here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const { at } = require('./helpers');

const MAIN_PATH = require.resolve('../src/main/main.js');

// ---- Stand-ins ------------------------------------------------------------------------------------------

function makeFakeElectron({ userData, lock = true, saveTo, openFrom, packaged = false, displays }) {
  const fake = {
    appId: null,
    quitCalled: false,
    appEvents: {},
    ipc: {},
    ipcOn: {},
    windows: [],
    notifications: [],
    trays: [],
    messageBoxes: [],
    nextBox: { response: 0, checkboxChecked: false },
    loginSettings: [],
    powerEvents: {},
    dialogs: { saveTo, openFrom },
    displays: displays || [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }],
  };

  fake.app = {
    isPackaged: packaged,
    setAppUserModelId: (id) => { fake.appId = id; },
    requestSingleInstanceLock: () => lock,
    quit: () => { fake.quitCalled = true; },
    on: (event, fn) => { (fake.appEvents[event] = fake.appEvents[event] || []).push(fn); },
    whenReady: () => Promise.resolve(),
    getPath: () => userData,
    setAsDefaultProtocolClient: () => {},
    setLoginItemSettings: (settings) => fake.loginSettings.push(settings),
  };

  fake.BrowserWindow = class {
    constructor(options) {
      this.options = options;
      this.sent = [];
      this.handlers = {};
      this.visible = false;
      this.shownCount = 0;
      this.hiddenCount = 0;
      this.destroyed = false;
      this.webContents = {
        send: (channel, payload) => this.sent.push([channel, payload]),
        setWindowOpenHandler: () => {},
        on: () => {},
        isDestroyed: () => this.destroyed,
      };
      fake.windows.push(this);
    }
    setMenuBarVisibility() {}
    setAlwaysOnTop(flag, level) { this.alwaysOnTop = [flag, level]; }
    destroy() {
      this.destroyed = true;
      this.visible = false;
      (this.handlers.closed || []).forEach((fn) => fn({}));
    }
    loadFile(file) { this.file = file; }
    on(event, fn) { (this.handlers[event] = this.handlers[event] || []).push(fn); }
    once(event, fn) { this.on(event, fn); }
    // Pretend Windows/Electron raised an event. Returns an event object that records preventDefault().
    emit(event) {
      const e = { prevented: false, preventDefault() { this.prevented = true; } };
      (this.handlers[event] || []).forEach((fn) => fn(e));
      return e;
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    restore() {}
    show() { this.visible = true; this.shownCount += 1; }
    hide() { this.visible = false; this.hiddenCount += 1; }
    focus() {}
  };

  fake.Tray = class {
    constructor(image) { this.image = image; this.handlers = {}; this.destroyed = false; fake.trays.push(this); }
    setToolTip(text) { this.tooltip = text; }
    setContextMenu(menu) { this.menu = menu; }
    on(event, fn) { this.handlers[event] = fn; }
    destroy() { this.destroyed = true; }
    isDestroyed() { return this.destroyed; }
  };
  fake.screen = {
    getAllDisplays: () => fake.displays,
    getPrimaryDisplay: () => fake.displays[0],
  };
  fake.Menu = { buildFromTemplate: (template) => ({ template }) };
  fake.nativeImage = { createFromPath: (p) => ({ path: p, resize: (size) => ({ path: p, size }) }) };
  fake.powerMonitor = { on: (event, fn) => { fake.powerEvents[event] = fn; } };

  fake.ipcMain = {
    handle: (channel, fn) => { fake.ipc[channel] = fn; },
    on: (channel, fn) => { fake.ipcOn[channel] = fn; },
  };

  fake.dialog = {
    showSaveDialog: async () => (fake.dialogs.saveTo ? { canceled: false, filePath: fake.dialogs.saveTo } : { canceled: true }),
    showOpenDialog: async () => (fake.dialogs.openFrom ? { canceled: false, filePaths: [fake.dialogs.openFrom] } : { canceled: true }),
    showMessageBox: async (options) => {
      fake.messageBoxes.push(options);
      return fake.nextBox;
    },
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
      const time = (h, m) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), h, m, 0, 0);
      this.fajr = time(5, 5);
      this.dhuhr = time(11, 48);
      this.asr = time(15, 14);
      this.maghrib = time(18, 0);
      this.isha = time(19, 20);
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
  if (options.hidden) process.argv.push('--hidden');
  let mainModule;
  try {
    mainModule = require(MAIN_PATH);
    await new Promise((resolve) => setImmediate(resolve)); // let app.whenReady().then(...) run
  } finally {
    if (options.hidden) process.argv.pop();
  }
  fake.userData = userData;
  fake.main = mainModule;
  fake.win = () => fake.windows.find((w) => w.options.title === 'Daily Planner');
  fake.alertWindows = () => fake.windows.filter((w) => w.options.title === 'Daily Planner reminder' && !w.destroyed);
  fake.fire = (h, m, sec = 0) => tickEngineAt(fake, h, m, sec);
  fake.svc = (method, ...args) => fake.ipc.svc({}, method, args);
  fake.dataFile = () => JSON.parse(fs.readFileSync(path.join(userData, 'data.json'), 'utf8'));
  fake.settleDialogs = () => new Promise((resolve) => setImmediate(resolve));
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

function tickEngineAt(fake, h, m, sec) {
  const engine = fake.main.getEngine();
  return engine.tick(new Date(2030, 0, 10, h, m, sec, 0));
}

const trayItem = (app, label) => app.trays[0].menu.template.find((item) => item.label === label);

// ---- Start-up -----------------------------------------------------------------------------------------------

test('Start-up: app id, one secure window showing our page, shown when ready', async () => {
  const app = await launch();
  assert.equal(app.appId, 'com.dailyplanner.app');
  assert.equal(app.windows.length, 1);
  const win = app.win();
  assert.equal(win.options.show, false, 'created hidden, shown once ready (no white flash)');
  assert.equal(win.options.webPreferences.contextIsolation, true);
  assert.equal(win.options.webPreferences.nodeIntegration, false);
  assert.equal(win.options.webPreferences.sandbox, true);
  assert.ok(fs.existsSync(win.file), 'the page exists');
  assert.ok(fs.existsSync(win.options.webPreferences.preload), 'the preload script exists');
  assert.ok(fs.existsSync(win.options.icon), 'the icon exists');
  assert.equal(win.visible, false);
  win.emit('ready-to-show');
  assert.equal(win.visible, true);
  app.cleanup();
});

test('22. Started by Windows at login (--hidden): stays hidden in the tray', async () => {
  const app = await launch({ hidden: true });
  const win = app.win();
  win.emit('ready-to-show');
  assert.equal(win.visible, false, 'the window does not pop up');
  assert.equal(app.trays.length, 1, 'but the tray icon is there');
  assert.ok(app.main.getEngine(), 'and the reminder engine is running');
  trayItem(app, 'Open / Show').click();
  assert.equal(win.visible, true, 'it opens from the tray');
  app.cleanup();
});

test('22b. "Start with Windows" registers the app to start at login, hidden in the tray', async () => {
  const app = await launch({ packaged: true });
  assert.deepEqual(app.loginSettings.pop(), { openAtLogin: false, args: ['--hidden'] });
  await app.svc('saveSettings', { startWithWindows: true });
  assert.deepEqual(app.loginSettings.pop(), { openAtLogin: true, args: ['--hidden'] });
  await app.svc('saveSettings', { theme: 'dark' });
  assert.equal(app.loginSettings.length, 0, 'unrelated changes do not touch the registration');
  await app.svc('saveSettings', { startWithWindows: false });
  assert.deepEqual(app.loginSettings.pop(), { openAtLogin: false, args: ['--hidden'] });
  app.cleanup();
});

test('22c. A development run never registers itself with Windows', async () => {
  const app = await launch({ packaged: false });
  await app.svc('saveSettings', { startWithWindows: true });
  assert.equal(app.loginSettings.length, 0);
  app.cleanup();
});

// ---- Closing, minimizing, the tray ------------------------------------------------------------------------------

test('Closing the window hides it to the tray; the app keeps running', async () => {
  const app = await launch();
  const win = app.win();
  win.emit('ready-to-show');
  const event = win.emit('close');
  assert.equal(event.prevented, true, 'the window is not destroyed');
  assert.equal(win.visible, false);
  assert.equal(app.quitCalled, false);
  assert.equal(app.trays[0].destroyed, false);
  app.appEvents['window-all-closed'][0](); // the app does not quit when there are no windows
  assert.equal(app.quitCalled, false);
  app.cleanup();
});

test('Minimizing hides to the tray without any message', async () => {
  const app = await launch();
  const win = app.win();
  win.emit('ready-to-show');
  const event = win.emit('minimize');
  assert.equal(event.prevented, true);
  assert.equal(win.visible, false);
  await app.settleDialogs();
  assert.equal(app.messageBoxes.length, 0);
  app.cleanup();
});

test('First close: "still running in the background" message, once', async () => {
  const app = await launch();
  const win = app.win();
  win.emit('ready-to-show');
  win.emit('close');
  await app.settleDialogs();
  assert.equal(app.messageBoxes.length, 1);
  const box = app.messageBoxes[0];
  assert.match(box.message, /still running in the background/);
  assert.match(box.detail, /Exit/);
  assert.equal(box.checkboxLabel, "Don't show this again");
  assert.equal(app.dataFile().settings.backgroundMessageShown, true);
  assert.equal(app.dataFile().settings.showBackgroundMessage, true, 'not switched off unless the user asks');

  trayItem(app, 'Open / Show').click();
  win.emit('close');
  await app.settleDialogs();
  assert.equal(app.messageBoxes.length, 1, 'not shown a second time');
  app.cleanup();
});

test('"Don\'t show again" turns the message off; Settings can turn it back on', async () => {
  const app = await launch();
  app.nextBox = { response: 0, checkboxChecked: true };
  const win = app.win();
  win.emit('close');
  await app.settleDialogs();
  assert.equal(app.dataFile().settings.showBackgroundMessage, false);

  await app.svc('saveSettings', { showBackgroundMessage: true });
  assert.equal(app.dataFile().settings.backgroundMessageShown, false, 'will be shown at the next close');
  app.nextBox = { response: 0, checkboxChecked: false };
  win.emit('close');
  await app.settleDialogs();
  assert.equal(app.messageBoxes.length, 2);
  app.cleanup();
});

test('Tray: tooltip, icon, and the Open / Hide / Exit menu', async () => {
  const app = await launch();
  const tray = app.trays[0];
  assert.equal(tray.tooltip, 'Daily Planner');
  assert.ok(tray.image.path.endsWith('icon.png'));
  assert.deepEqual(tray.image.size, { width: 16, height: 16 });
  assert.deepEqual(tray.menu.template.map((i) => i.label || i.type), ['Open / Show', 'Hide / Minimize', 'separator', 'Exit']);

  const win = app.win();
  win.emit('ready-to-show');
  trayItem(app, 'Hide / Minimize').click();
  assert.equal(win.visible, false);
  tray.handlers['double-click']();
  assert.equal(win.visible, true, 'double-click opens the window');
  trayItem(app, 'Hide / Minimize').click();
  tray.handlers.click();
  assert.equal(win.visible, true, 'a single click opens it too');
  app.cleanup();
});

test('Opening from the tray after the window was destroyed creates a new window', async () => {
  const app = await launch();
  const first = app.win();
  first.emit('closed');
  trayItem(app, 'Open / Show').click();
  assert.equal(app.windows.length, 2);
  app.windows[1].emit('ready-to-show');
  assert.equal(app.windows[1].visible, true);
  app.cleanup();
});

test('Exit asks for confirmation; Cancel keeps running; Exit really quits', async () => {
  const app = await launch();
  const win = app.win();
  win.emit('ready-to-show');

  app.nextBox = { response: 1 }; // Cancel
  await trayItem(app, 'Exit').click();
  assert.equal(app.quitCalled, false);
  const box = app.messageBoxes[0];
  assert.match(box.message, /Exit Daily Planner/);
  assert.match(box.detail, /Reminders and notifications will stop/);
  assert.deepEqual(box.buttons, ['Exit', 'Cancel']);
  assert.equal(win.emit('close').prevented, true, 'still hides instead of closing');

  app.nextBox = { response: 0 }; // Exit
  await trayItem(app, 'Exit').click();
  assert.equal(app.quitCalled, true);
  assert.equal(win.emit('close').prevented, false, 'now the window is allowed to close');
  app.appEvents['will-quit'][0]();
  assert.equal(app.trays[0].destroyed, true, 'the tray icon is removed');
  app.cleanup();
});

test('Windows shutting down or logging off is never blocked', async () => {
  const app = await launch();
  const win = app.win();
  win.emit('session-end');
  assert.equal(win.emit('close').prevented, false);
  app.cleanup();
});

// ---- Single instance, links ---------------------------------------------------------------------------------------------

test('21. A second copy quits immediately; the first brings its (hidden) window forward', async () => {
  const second = await launch({ lock: false });
  assert.equal(second.quitCalled, true);
  assert.equal(second.windows.length, 0);
  assert.equal(second.trays.length, 0);
  second.cleanup();

  const first = await launch();
  const win = first.win();
  win.emit('ready-to-show');
  trayItem(first, 'Hide / Minimize').click();
  assert.equal(win.visible, false);
  first.appEvents['second-instance'][0]({}, ['Daily Planner.exe']);
  assert.equal(win.visible, true, 'the existing window is shown');
  assert.equal(first.windows.length, 1, 'no second window');
  first.cleanup();
});

test('Notification buttons: Mark as Done and Snooze act quietly, without showing the window', async () => {
  const app = await launch();
  const { taskId } = await app.svc('saveTask', { mode: 'create', form: form() });
  const win = app.win();
  win.emit('ready-to-show');
  trayItem(app, 'Hide / Minimize').click();
  const shownBefore = win.shownCount;

  app.appEvents['second-instance'][0]({}, ['Daily Planner.exe', `dailyplanner://snooze?task=${taskId}&date=2030-01-10`]);
  assert.equal(app.dataFile().reminderState.snoozed.length, 1);

  app.appEvents['second-instance'][0]({}, ['Daily Planner.exe', `dailyplanner://done?task=${taskId}&date=2030-01-10`]);
  const saved = app.dataFile();
  assert.equal(saved.tasks[0].completions['2030-01-10'], true);
  assert.equal(saved.reminderState.snoozed.length, 0, 'done cancels the snooze');
  assert.equal(win.shownCount, shownBefore, 'the window was not brought up');
  app.cleanup();
});

test('Clicking a notification opens the window on that task', async () => {
  const app = await launch();
  const { taskId } = await app.svc('saveTask', { mode: 'create', form: form() });
  const win = app.win();
  win.emit('ready-to-show');
  trayItem(app, 'Hide / Minimize').click();

  // The window page is not ready yet: the request waits
  app.appEvents['second-instance'][0]({}, ['x.exe', `dailyplanner://open?task=${taskId}&date=2030-01-10`]);
  assert.equal(win.visible, true);
  assert.ok(!win.sent.some(([c]) => c === 'open-task'));

  app.ipcOn['renderer-ready']();
  assert.deepEqual(win.sent.find(([c]) => c === 'open-task')[1], { taskId, dateKey: '2030-01-10' });
  app.cleanup();
});

// ---- Reminders keep working in the background ---------------------------------------------------------------------------

test('19. With the window hidden in the tray, reminders still produce Windows notifications', async () => {
  const app = await launch();
  const win = app.win();
  win.emit('ready-to-show');
  win.emit('close'); // hidden in the tray
  assert.equal(win.visible, false);

  await app.svc('saveTask', { mode: 'create', form: form({ title: 'Background reminder' }) });
  const engine = app.main.getEngine();
  engine.tick(at('2030-01-10', '22:59'));
  assert.equal(app.notifications.length, 0);
  engine.tick(at('2030-01-10', '23:00'));
  assert.equal(app.notifications.length, 1);
  const toast = app.notifications[0];
  assert.equal(toast.shown, true);
  assert.ok(toast.options.toastXml.includes('Background reminder'));
  assert.ok(toast.options.toastXml.includes('Snooze 5 min'));
  assert.equal(win.visible, false, 'the window stayed hidden');
  app.cleanup();
});

test('Wake from sleep runs a check at once and refreshes the window', async () => {
  const app = await launch();
  app.ipcOn['renderer-ready']();
  const win = app.win();
  const before = app.main.getEngine().state.lastTickAt;
  assert.ok(app.powerEvents.resume && app.powerEvents['unlock-screen']);
  await new Promise((resolve) => setTimeout(resolve, 5));
  app.powerEvents.resume();
  assert.ok(app.main.getEngine().state.lastTickAt >= before);
  assert.ok(win.sent.some(([channel]) => channel === 'data-changed'));
  app.cleanup();
});

test('Quitting stops the reminder engine and saves its state', async () => {
  const app = await launch();
  app.appEvents['before-quit'][0]();
  assert.ok(app.dataFile().reminderState.lastTickAt > 0);
  app.cleanup();
});

// ---- Window <-> service ------------------------------------------------------------------------------------------------------

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
  assert.ok(app.win().sent.some(([channel]) => channel === 'data-changed'));
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

test('The test notification works, and so do its buttons (checks the link route end to end)', async () => {
  const app = await launch();
  const result = await app.ipc['test-notification']();
  assert.equal(result.ok, true);
  assert.equal(app.notifications.length, 1);
  const xml = app.notifications[0].options.toastXml;
  assert.ok(xml.includes('Daily Planner test notification'));
  assert.ok(xml.includes('Mark as Done'));

  // Pretend Windows opened the app with the link behind each button
  const links = [...xml.matchAll(/arguments="(dailyplanner:[^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
  assert.equal(links.length, 2);
  app.appEvents['second-instance'][0]({}, ['Daily Planner.exe', links[0]]);
  assert.equal(app.notifications.length, 2);
  assert.ok(app.notifications[1].options.toastXml.includes('The notification buttons work'));
  assert.ok(app.notifications[1].options.toastXml.includes('Snooze'));
  assert.equal(app.dataFile().reminderState.snoozed.length, 0, 'the test does not create a real snooze');
  app.appEvents['second-instance'][0]({}, ['Daily Planner.exe', links[1]]);
  assert.ok(app.notifications[2].options.toastXml.includes('Mark as Done'));
  app.cleanup();
});


// ---- The full-screen alert -----------------------------------------------------------------------------------------

function alertForm(extra = {}) {
  return form({
    title: 'Alert task', notes: 'Read these notes first', start: { mode: 'fixed', time: '12:00' },
    reminders: { enabled: false, offsets: [], fullScreen: true }, ...extra,
  });
}

const twoScreens = [
  { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
  { id: 2, bounds: { x: 1920, y: 0, width: 1280, height: 1024 } },
];

test('Full-screen alert: at the start time one borderless window covers each screen, above everything', async () => {
  const app = await launch({ displays: twoScreens });
  await app.svc('saveTask', { mode: 'create', form: alertForm() });
  app.fire(11, 59, 50);
  assert.equal(app.alertWindows().length, 0, 'nothing before the start time');
  app.fire(12, 0, 0);

  const windows = app.alertWindows();
  assert.equal(windows.length, 2, 'one per screen');
  windows.forEach((win, i) => {
    const o = win.options;
    const b = twoScreens[i].bounds;
    assert.deepEqual([o.x, o.y, o.width, o.height], [b.x, b.y, b.width, b.height]);
    assert.equal(o.frame, false);
    assert.equal(o.fullscreen, true);
    assert.equal(o.alwaysOnTop, true);
    assert.equal(o.skipTaskbar, true);
    assert.equal(o.show, false);
    assert.equal(o.webPreferences.contextIsolation, true);
    assert.equal(o.webPreferences.nodeIntegration, false);
    assert.equal(o.webPreferences.sandbox, true);
    assert.ok(o.webPreferences.preload.endsWith('alert-preload.js') && fs.existsSync(o.webPreferences.preload));
    assert.ok(win.file.endsWith('alert.html') && fs.existsSync(win.file));
    assert.deepEqual(win.alwaysOnTop, [true, 'screen-saver']);
    win.emit('ready-to-show');
    assert.equal(win.visible, true);
  });
  assert.equal(app.alertWindows().length, 2);
  app.cleanup();
});

test('Full-screen alert: the page is told what to show (title, notes, times, zone, look)', async () => {
  const app = await launch();
  await app.svc('saveTask', { mode: 'create', form: alertForm() });
  app.fire(11, 59, 50);
  app.fire(12, 0, 0);
  const win = app.alertWindows()[0];
  app.ipcOn['alert-ready']({ sender: win.webContents });
  const [channel, state] = win.sent.find(([c]) => c === 'alert-render');
  assert.equal(channel, 'alert-render');
  assert.equal(state.items.length, 1);
  const item = state.items[0];
  assert.equal(item.title, 'Alert task');
  assert.equal(item.notes, 'Read these notes first');
  assert.equal(item.startLabel, '12:00 PM');
  assert.equal(item.endLabel, '12:30 PM');
  assert.equal(item.durationLabel, '30m');
  assert.equal(item.zoneName, 'Dhuhr → Asr');
  assert.equal(item.priority, 'Medium');
  assert.equal(state.appearance.backgroundColor, '#0f172a');
  assert.equal(state.snoozeMinutes, 5);
  assert.equal(state.guardMs, 1500);
  app.cleanup();
});

test('Full-screen alert: the plain notification at the start is replaced by it', async () => {
  const app = await launch();
  await app.svc('saveTask', { mode: 'create', form: alertForm({ reminders: { enabled: true, offsets: [0], fullScreen: true } }) });
  app.fire(11, 59, 50);
  app.fire(12, 0, 0);
  assert.equal(app.alertWindows().length, 1);
  assert.equal(app.notifications.length, 0);
  app.cleanup();
});

test('Full-screen alert buttons: Got it, Mark as Done, Snooze, Open task', async () => {
  const app = await launch();
  const { taskId } = await app.svc('saveTask', { mode: 'create', form: alertForm() });
  app.win().emit('ready-to-show');
  app.ipcOn['renderer-ready']();
  app.fire(11, 59, 50);
  app.fire(12, 0, 0);
  const win = app.alertWindows()[0];
  app.ipcOn['alert-ready']({ sender: win.webContents });
  const itemId = win.sent.find(([c]) => c === 'alert-render')[1].items[0].id;

  // Someone else (the main window) cannot press the alert's buttons
  app.ipcOn['alert-action']({ sender: app.win().webContents }, { type: 'done', itemId });
  assert.equal(app.alertWindows().length, 1);
  // Unknown button / unknown task: ignored
  app.ipcOn['alert-action']({ sender: win.webContents }, { type: 'format-disk', itemId });
  app.ipcOn['alert-action']({ sender: win.webContents }, { type: 'done', itemId: 'nope' });
  app.ipcOn['alert-action']({ sender: win.webContents }, null);
  assert.equal(app.alertWindows().length, 1);
  assert.equal(app.dataFile().tasks[0].completions['2030-01-10'], undefined);

  // Snooze: the alert closes, and a snooze that will come back as an alert is stored
  app.ipcOn['alert-action']({ sender: win.webContents }, { type: 'snooze', itemId });
  assert.equal(app.alertWindows().length, 0);
  const snoozed = app.dataFile().reminderState.snoozed;
  assert.equal(snoozed.length, 1);
  assert.equal(snoozed[0].fullScreen, true);
  assert.equal(snoozed[0].taskId, taskId);
  app.cleanup();
});

test('Full-screen alert: Mark as Done completes the task; Open task opens the app; Got it only closes', async () => {
  const app = await launch();
  await app.svc('saveTask', { mode: 'create', form: alertForm({ title: 'One' }) });
  app.win().emit('ready-to-show');
  app.ipcOn['renderer-ready']();
  app.fire(11, 59, 50);
  app.fire(12, 0, 0);
  let win = app.alertWindows()[0];
  app.ipcOn['alert-ready']({ sender: win.webContents });
  let itemId = win.sent.find(([c]) => c === 'alert-render')[1].items[0].id;
  app.ipcOn['alert-action']({ sender: win.webContents }, { type: 'done', itemId });
  assert.equal(app.alertWindows().length, 0);
  assert.equal(app.dataFile().tasks[0].completions['2030-01-10'], true);

  // Open task
  await app.svc('saveTask', { mode: 'create', form: alertForm({ title: 'Two', start: { mode: 'fixed', time: '13:00' } }) });
  app.fire(12, 59, 50);
  app.fire(13, 0, 0);
  win = app.alertWindows()[0];
  app.ipcOn['alert-ready']({ sender: win.webContents });
  itemId = win.sent.filter(([c]) => c === 'alert-render').pop()[1].items[0].id;
  const mainWin = app.win();
  mainWin.visible = false;
  app.ipcOn['alert-action']({ sender: win.webContents }, { type: 'open', itemId });
  assert.equal(mainWin.visible, true, 'the main window is brought up');
  const open = mainWin.sent.filter(([c]) => c === 'open-task').pop();
  assert.equal(open[1].dateKey, '2030-01-10');
  assert.equal(app.alertWindows().length, 0);

  // Got it
  await app.svc('saveTask', { mode: 'create', form: alertForm({ title: 'Three', start: { mode: 'fixed', time: '14:00' } }) });
  app.fire(13, 59, 50);
  app.fire(14, 0, 0);
  win = app.alertWindows()[0];
  app.ipcOn['alert-ready']({ sender: win.webContents });
  itemId = win.sent.filter(([c]) => c === 'alert-render').pop()[1].items[0].id;
  app.ipcOn['alert-action']({ sender: win.webContents }, { type: 'dismiss', itemId });
  assert.equal(app.alertWindows().length, 0);
  assert.equal(app.dataFile().tasks.find((t) => t.title === 'Three').completions['2030-01-10'], undefined);
  app.cleanup();
});

test('Full-screen alert: tasks starting together queue up on the same screens', async () => {
  const app = await launch({ displays: twoScreens });
  await app.svc('saveTask', { mode: 'create', form: alertForm({ title: 'First' }) });
  await app.svc('saveTask', { mode: 'create', form: alertForm({ title: 'Second' }) });
  app.fire(11, 59, 50);
  app.fire(12, 0, 0);
  assert.equal(app.alertWindows().length, 2, 'still just one window per screen');
  const [a, b] = app.alertWindows();
  app.ipcOn['alert-ready']({ sender: a.webContents });
  const queue = a.sent.filter(([c]) => c === 'alert-render').pop()[1].items;
  assert.equal(queue.length, 2);

  app.ipcOn['alert-action']({ sender: b.webContents }, { type: 'dismiss', itemId: queue[0].id }); // pressed on the other screen
  assert.equal(app.alertWindows().length, 2, 'the next task appears');
  const next = a.sent.filter(([c]) => c === 'alert-render').pop()[1];
  assert.deepEqual(next.items.map((i) => i.title), [queue[1].title]);
  assert.equal(next.guardMs, 700, 'a short pause before the next one can be pressed');

  app.ipcOn['alert-action']({ sender: a.webContents }, { type: 'dismiss', itemId: queue[1].id });
  assert.equal(app.alertWindows().length, 0);
  app.cleanup();
});

test('Full-screen alert: a task that starts while the alert is open joins the queue', async () => {
  const app = await launch();
  await app.svc('saveTask', { mode: 'create', form: alertForm({ title: 'First' }) });
  await app.svc('saveTask', { mode: 'create', form: alertForm({ title: 'Later', start: { mode: 'fixed', time: '12:05' } }) });
  app.fire(11, 59, 50);
  app.fire(12, 0, 0);
  const win = app.alertWindows()[0];
  app.fire(12, 5, 0);
  assert.equal(app.alertWindows().length, 1);
  const state = win.sent.filter(([c]) => c === 'alert-render').pop()[1];
  assert.deepEqual(state.items.map((i) => i.title), ['First', 'Later']);
  app.cleanup();
});

test('Full-screen alert: "Main screen only" uses just the primary screen', async () => {
  const app = await launch({ displays: twoScreens });
  await app.svc('saveSettings', { alertScreens: 'main' });
  await app.svc('saveTask', { mode: 'create', form: alertForm() });
  app.fire(11, 59, 50);
  app.fire(12, 0, 0);
  assert.equal(app.alertWindows().length, 1);
  assert.equal(app.alertWindows()[0].options.x, 0);
  app.cleanup();
});

test('Full-screen alert: the look chosen in Settings is what the page receives', async () => {
  const app = await launch();
  await app.svc('saveSettings', { alertAppearance: { backgroundColor: '#112233', name: { size: 120, uppercase: true }, notes: { show: false } } });
  await app.svc('saveTask', { mode: 'create', form: alertForm() });
  app.fire(11, 59, 50);
  app.fire(12, 0, 0);
  const win = app.alertWindows()[0];
  assert.equal(win.options.backgroundColor, '#112233', 'no white flash before the page loads');
  app.ipcOn['alert-ready']({ sender: win.webContents });
  const { appearance } = win.sent.find(([c]) => c === 'alert-render')[1];
  assert.equal(appearance.backgroundColor, '#112233');
  assert.equal(appearance.name.size, 120);
  assert.equal(appearance.name.uppercase, true);
  assert.equal(appearance.name.bold, true, 'what was not changed stays');
  assert.equal(appearance.notes.show, false);
  app.cleanup();
});

test('Full-screen alert: the Preview button shows the real thing with an example, and does nothing real', async () => {
  const app = await launch();
  const result = await app.ipc['preview-alert']();
  assert.equal(result.ok, true);
  const win = app.alertWindows()[0];
  app.ipcOn['alert-ready']({ sender: win.webContents });
  const item = win.sent.find(([c]) => c === 'alert-render')[1].items[0];
  assert.equal(item.taskId, '__sample__');
  app.ipcOn['alert-action']({ sender: win.webContents }, { type: 'done', itemId: item.id });
  assert.equal(app.alertWindows().length, 0);
  assert.equal(app.dataFile().tasks.length, 0);
  assert.equal(app.dataFile().reminderState.snoozed.length, 0);
  app.cleanup();
});

test('Full-screen alert: switched off in Settings, nothing appears; quitting closes any open alert', async () => {
  const off = await launch();
  await off.svc('saveSettings', { fullScreenAlerts: false });
  await off.svc('saveTask', { mode: 'create', form: alertForm() });
  off.fire(11, 59, 50);
  off.fire(12, 0, 0);
  assert.equal(off.alertWindows().length, 0);
  off.cleanup();

  const on = await launch();
  await on.svc('saveTask', { mode: 'create', form: alertForm() });
  on.fire(11, 59, 50);
  on.fire(12, 0, 0);
  assert.equal(on.alertWindows().length, 1);
  on.appEvents['before-quit'][0]();
  assert.equal(on.alertWindows().length, 0);
  on.cleanup();
});

test('New tasks follow the "switch on for new tasks" setting', async () => {
  const app = await launch();
  const before = await app.svc('newTaskDefaults', '2030-01-10');
  assert.equal(before.reminders.fullScreen, false);
  await app.svc('saveSettings', { fullScreenDefaultForNewTasks: true });
  const after = await app.svc('newTaskDefaults', '2030-01-10');
  assert.equal(after.reminders.fullScreen, true);
  app.cleanup();
});

test('The alert page preload exposes only what it needs', () => {
  const sent = [];
  const exposed = {};
  stand.electron = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
    ipcRenderer: { send: (...args) => sent.push(args), on: () => {} },
  };
  delete require.cache[require.resolve('../src/main/alert-preload.js')];
  require('../src/main/alert-preload.js');
  assert.deepEqual(Object.keys(exposed.alertApi).sort(), ['action', 'onRender', 'ready']);
  exposed.alertApi.action('done', 'abc');
  assert.deepEqual(sent[0], ['alert-action', { type: 'done', itemId: 'abc' }]);
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
  assert.deepEqual(Object.keys(exposed.api).sort(), ['call', 'exportData', 'importData', 'on', 'previewAlert', 'ready', 'testNotification']);
  exposed.api.call('getDay', '2030-01-10');
  assert.deepEqual(sent[0], ['svc', 'getDay', ['2030-01-10']]);
});
