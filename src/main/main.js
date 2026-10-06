'use strict';

// Daily Planner - Electron main process.
//
// Milestone 4 wiring: window, saved data, the planner service, the reminder engine with Windows
// notifications, and links from notification buttons.
// Milestone 5 adds: system tray, "close hides to the tray", start with Windows.

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, Notification } = require('electron');

const { PlannerService, PUBLIC_METHODS } = require('./service');
const { FileStore } = require('./store');
const { ReminderEngine } = require('../core/reminder-engine');
const { formatTime12 } = require('../core/time');
const { createElectronNotifier, findActionUrlInArgv, APP_ID, PROTOCOL } = require('./toast');

const ICON = path.join(__dirname, 'icon.png');

let mainWindow = null;
let service = null;
let engine = null;
let notify = null;
let rendererReady = false;
const pendingEvents = []; // events waiting for the window to be ready

function log(...args) {
  // Written to the console only (visible when started from a terminal).
  console.error('[daily-planner]', ...args);
}

// ---- Talking to the window ------------------------------------------------------------------------------

function sendToWindow(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed() && rendererReady) {
    mainWindow.webContents.send(channel, payload);
  } else if (channel !== 'data-changed') {
    pendingEvents.push({ channel, payload });
  }
}

function flushPendingEvents() {
  while (pendingEvents.length > 0) {
    const { channel, payload } = pendingEvents.shift();
    mainWindow.webContents.send(channel, payload);
  }
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  rendererReady = false;
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 860,
    minWidth: 640,
    minHeight: 520,
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

  // The window only ever shows our own page.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  mainWindow.on('closed', () => {
    mainWindow = null;
    rendererReady = false;
  });
}

// ---- Notification buttons and links --------------------------------------------------------------------------

// action: { type: 'snooze' | 'done' | 'open' | 'missed', taskId, dateKey }
function handleAction(action) {
  if (!action) return;
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

// ---- Reminder engine --------------------------------------------------------------------------------------------

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

// ---- Start-up -------------------------------------------------------------------------------------------------------

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

  ipcMain.on('renderer-ready', () => {
    rendererReady = true;
    flushPendingEvents();
  });
}

function start() {
  app.setAppUserModelId(APP_ID);

  // Only one copy runs. A second launch (for example from a notification button) is handed
  // to the running copy through the "second-instance" event.
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
    });
    registerIpc();
    if (app.isPackaged) app.setAsDefaultProtocolClient(PROTOCOL);

    startEngine();
    createWindow();

    const launchAction = findActionUrlInArgv(process.argv);
    if (launchAction) handleAction(launchAction);

    app.on('activate', showWindow);
  });

  // Milestone 4: closing the window quits the app. (Milestone 5 changes this to "keep running in the tray".)
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    if (engine) engine.stop();
  });
}

start();

module.exports = { handleAction };
