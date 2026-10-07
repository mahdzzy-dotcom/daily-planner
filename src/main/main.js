'use strict';

// Daily Planner - Electron main process.
//
// The app is a background task manager, not just a window:
//   Windows start-up -> background operation -> system tray -> reminder engine -> Windows notifications
//
//   - Closing (X) or minimizing the window hides it to the tray; the app keeps running.
//   - "Exit" in the tray menu is the only way to stop it (after a confirmation).
//   - "Start with Windows" launches it at login, hidden in the tray.
//   - Only one copy runs; launching it again brings the running copy forward.
//   - Reminders come from the engine in this process, so they do not depend on the window.

const path = require('path');
const fs = require('fs');
const {
  app, BrowserWindow, ipcMain, dialog, Notification, Tray, Menu, nativeImage, powerMonitor,
} = require('electron');

const { PlannerService, PUBLIC_METHODS } = require('./service');
const { FileStore } = require('./store');
const { ReminderEngine } = require('../core/reminder-engine');
const { formatTime12 } = require('../core/time');
const { createElectronNotifier, findActionUrlInArgv, APP_ID, PROTOCOL } = require('./toast');
const { createTray } = require('./tray');

const ICON = path.join(__dirname, 'icon.png');
const STARTUP_ARG = '--hidden'; // given to the app when Windows starts it at login
const WATCHDOG_MS = 60000;
const TEST_TASK_ID = '__test__'; // marks the buttons of the test notification

let mainWindow = null;
let service = null;
let engine = null;
let notify = null;
let trayController = null;
let watchdog = null;
let rendererReady = false;
let quitting = false; // true only when the app is really being closed
let showOnReady = true;
let lastLoginSetting = null;
let lastOffset = null;
const pendingEvents = []; // events waiting for the window to be ready

function log(...args) {
  // Console only (visible when started from a terminal).
  console.error('[daily-planner]', ...args);
}

// ---- Talking to the window ---------------------------------------------------------------------------------

function sendToWindow(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed() && rendererReady) {
    mainWindow.webContents.send(channel, payload);
  } else if (channel !== 'data-changed') {
    pendingEvents.push({ channel, payload });
  }
}

function flushPendingEvents() {
  while (pendingEvents.length > 0 && mainWindow && !mainWindow.isDestroyed()) {
    const { channel, payload } = pendingEvents.shift();
    mainWindow.webContents.send(channel, payload);
  }
}

// ---- The window --------------------------------------------------------------------------------------------------

function createWindow({ visible }) {
  rendererReady = false;
  showOnReady = visible;
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 860,
    minWidth: 640,
    minHeight: 520,
    show: false, // shown when ready (or kept hidden for a start with Windows)
    title: 'Daily Planner',
    icon: ICON,
    backgroundColor: '#f4f6f9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    if (showOnReady && mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  });

  // The window only ever shows our own page.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  // Closing or minimizing hides the window to the tray instead of ending the app.
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    hideToTray(true);
  });
  mainWindow.on('minimize', (event) => {
    if (quitting) return;
    event.preventDefault();
    hideToTray(false);
  });
  // Windows is shutting down or logging off: never get in its way.
  mainWindow.on('session-end', () => {
    quitting = true;
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    rendererReady = false;
  });
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow({ visible: true });
    return;
  }
  showOnReady = true;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function hideWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
}

function hideToTray(announce) {
  hideWindow();
  if (announce) announceBackgroundRunning().catch((error) => log('Message failed:', error));
}

// The first time the window is closed: "still running in the background", with "Don't show again".
async function announceBackgroundRunning() {
  const settings = service.getSettings();
  if (!settings.showBackgroundMessage || settings.backgroundMessageShown) return;
  service.saveSettings({ backgroundMessageShown: true });
  const result = await dialog.showMessageBox({
    type: 'info',
    title: 'Daily Planner',
    message: 'Daily Planner is still running in the background.',
    detail:
      'It stays in the system tray (the icons near the clock) so your reminders keep working. ' +
      'To close it completely, right-click its tray icon and choose Exit.',
    buttons: ['OK'],
    defaultId: 0,
    noLink: true,
    checkboxLabel: "Don't show this again",
    checkboxChecked: false,
  });
  if (result.checkboxChecked) service.saveSettings({ showBackgroundMessage: false });
}

// ---- Exit ---------------------------------------------------------------------------------------------------------------

async function confirmExit() {
  const result = await dialog.showMessageBox({
    type: 'question',
    title: 'Exit Daily Planner',
    message: 'Exit Daily Planner?',
    detail: 'Reminders and notifications will stop until you start Daily Planner again.',
    buttons: ['Exit', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (result.response === 0) {
    quitting = true;
    app.quit();
  }
}

// ---- Tray ----------------------------------------------------------------------------------------------------------------

// To add a tray menu item later, add one line here.
function trayActions() {
  return [
    { id: 'open', label: 'Open / Show', click: showWindow },
    { id: 'hide', label: 'Hide / Minimize', click: hideWindow },
    { id: 'exit', label: 'Exit', separatorBefore: true, click: confirmExit },
  ];
}

function startTray() {
  trayController = createTray(
    { Tray, Menu, nativeImage },
    { iconPath: ICON, tooltip: 'Daily Planner', actions: trayActions(), onOpen: showWindow }
  );
}

// ---- Notification buttons and links ---------------------------------------------------------------------------------------

// action: { type: 'snooze' | 'done' | 'open' | 'missed', taskId, dateKey }
function handleAction(action) {
  if (!action) return;
  if (action.taskId === TEST_TASK_ID) {
    // The test notification's buttons: show that the click reached the app.
    if (notify) {
      notify({
        kind: 'info',
        id: `test-reply-${Date.now()}`,
        title: 'The notification buttons work',
        lines: [`The “${action.type === 'done' ? 'Mark as Done' : 'Snooze'}” button reached Daily Planner.`],
        silent: true,
        actions: [],
      });
    }
    return;
  }
  if (action.type === 'snooze' || action.type === 'done') {
    // Buttons on a notification act quietly, without bringing the window up.
    try {
      engine.handleAction({ type: action.type, taskId: action.taskId, dateKey: action.dateKey });
    } catch (error) {
      log('Notification action failed:', error);
    }
    return;
  }
  showWindow();
  if (action.type === 'open' && action.taskId && action.dateKey) {
    sendToWindow('open-task', { taskId: action.taskId, dateKey: action.dateKey });
  }
}

// ---- Reminder engine ---------------------------------------------------------------------------------------------------------

function startEngine() {
  notify = createElectronNotifier({ Notification, onError: (error) => log('Notification failed:', error) });
  engine = new ReminderEngine({
    getTasks: () => service.getTasks(),
    getProvider: () => service.provider(),
    getSettings: () => service.getReminderSettings(),
    notify,
    onMissed: (items, payload) => {
      notify(payload);
      sendToWindow('missed', items.map((i) => ({
        taskId: i.taskId,
        dateKey: i.dateKey,
        title: i.title,
        startLabel: formatTime12(i.start),
        zoneName: i.zoneName,
        alreadyStarted: i.alreadyStarted,
      })));
    },
    updateTask: (task) => service.updateTaskFromEngine(task),
    initialState: service.getReminderState(),
    saveState: (state) => service.saveReminderState(state),
    onError: (error) => log('Reminder engine:', error),
  });
  engine.start();
}

// After wake from sleep, unlock, or a clock / time zone change: recalculate and check at once.
function onSystemChange() {
  if (engine) engine.onSystemChange();
  sendToWindow('data-changed');
}

function startSystemWatch() {
  powerMonitor.on('resume', onSystemChange);
  powerMonitor.on('unlock-screen', onSystemChange);

  // A change of the PC's time zone (or a daylight saving change) changes the UTC offset.
  lastOffset = new Date().getTimezoneOffset();
  watchdog = setInterval(() => {
    const offset = new Date().getTimezoneOffset();
    if (offset !== lastOffset) {
      lastOffset = offset;
      onSystemChange();
    }
  }, WATCHDOG_MS);
  if (watchdog && typeof watchdog.unref === 'function') watchdog.unref();
}

// ---- Start with Windows ---------------------------------------------------------------------------------------------------------

function applyStartWithWindows(settings) {
  if (!app.isPackaged) return; // never register the development program
  if (lastLoginSetting === settings.startWithWindows) return;
  lastLoginSetting = settings.startWithWindows;
  app.setLoginItemSettings({ openAtLogin: settings.startWithWindows, args: [STARTUP_ARG] });
}

// ---- Window <-> service connection -----------------------------------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('svc', async (event, method, args) => {
    if (!PUBLIC_METHODS.includes(method)) throw new Error('Unknown request.');
    return service[method](...(Array.isArray(args) ? args : []));
  });

  ipcMain.handle('export-data', async () => {
    const stamp = new Date().toISOString().slice(0, 10);
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export data',
      defaultPath: `daily-planner-backup-${stamp}.json`,
      filters: [{ name: 'Daily Planner backup', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    fs.writeFileSync(result.filePath, JSON.stringify(service.exportData(), null, 2), 'utf8');
    return { ok: true, path: result.filePath };
  });

  ipcMain.handle('import-data', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Import data',
      properties: ['openFile'],
      filters: [{ name: 'Daily Planner backup', extensions: ['json'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true };
    const text = fs.readFileSync(result.filePaths[0], 'utf8');
    return service.importData(text);
  });

  ipcMain.handle('test-notification', async () => {
    const settings = service.getSettings();
    notify({
      kind: 'task',
      id: `test-${Date.now()}`,
      title: 'Daily Planner test notification',
      lines: ['If you can see this, notifications work.', 'Try the buttons below.'],
      silent: !settings.soundEnabled,
      taskId: TEST_TASK_ID,
      dateKey: new Date().toISOString().slice(0, 10),
      actions: [
        { type: 'snooze', label: `Snooze ${settings.snoozeMinutes} min` },
        { type: 'done', label: 'Mark as Done' },
      ],
    });
    return { ok: true };
  });

  ipcMain.on('renderer-ready', () => {
    rendererReady = true;
    flushPendingEvents();
  });
}

// ---- Start-up -------------------------------------------------------------------------------------------------------------------------

function start() {
  app.setAppUserModelId(APP_ID);

  // Only one copy runs. A second launch (a double-click on the shortcut, or a notification
  // button) is handed to the running copy through the "second-instance" event.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', (event, argv) => {
    const action = findActionUrlInArgv(argv);
    if (action) handleAction(action);
    else showWindow();
  });

  app.whenReady().then(() => {
    const store = new FileStore(path.join(app.getPath('userData'), 'data.json'));
    service = new PlannerService({
      store,
      onDataChanged: () => sendToWindow('data-changed'),
      onSettingsChanged: applyStartWithWindows,
    });
    registerIpc();
    if (app.isPackaged) app.setAsDefaultProtocolClient(PROTOCOL);
    applyStartWithWindows(service.getSettings());

    startEngine();
    startTray();
    startSystemWatch();

    // Started by Windows at login: stay hidden in the tray.
    const startedHidden = process.argv.includes(STARTUP_ARG);
    createWindow({ visible: !startedHidden });

    const launchAction = findActionUrlInArgv(process.argv);
    if (launchAction) handleAction(launchAction);
  });

  // The app keeps running when there are no windows: it lives in the tray.
  app.on('window-all-closed', () => {});

  app.on('before-quit', () => {
    quitting = true;
    if (watchdog) clearInterval(watchdog);
    if (engine) engine.stop();
  });
  app.on('will-quit', () => {
    if (trayController) trayController.destroy();
  });
}

start();

module.exports = { handleAction, getEngine: () => engine };
