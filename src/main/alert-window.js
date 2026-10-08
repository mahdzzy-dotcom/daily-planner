'use strict';

// The full-screen reminder windows.
//
// When tasks start, one borderless window covers each screen (or only the main one, if chosen in
// Settings), above other windows. All windows show the same thing: the first task in the queue in
// full, and a line such as "2 more tasks starting now". Clicking a button on any screen acts on the
// current task and moves everything on to the next one. When the queue is empty the windows close.
//
// The Electron pieces are passed in (not imported), so this can be tested without Electron.

const GUARD_FIRST_MS = 1500; // buttons and keys ignored at first, so typing cannot dismiss it by accident
const GUARD_NEXT_MS = 700; // shorter pause when the next task comes up

const ACTIONS = ['dismiss', 'snooze', 'done', 'open'];

function createAlertManager({ BrowserWindow, screen, preloadPath, pagePath, getConfig, log = () => {} }) {
  let items = [];
  let windows = [];
  let guardMs = GUARD_FIRST_MS;

  function payload() {
    const config = getConfig();
    return {
      items,
      appearance: config.appearance,
      snoozeMinutes: config.snoozeMinutes,
      guardMs,
    };
  }

  function alive(win) {
    return win && !win.isDestroyed();
  }

  function broadcast() {
    const data = payload();
    for (const win of windows) if (alive(win)) win.webContents.send('alert-render', data);
  }

  function closeAll() {
    const open = windows;
    windows = [];
    items = [];
    guardMs = GUARD_FIRST_MS;
    for (const win of open) {
      if (alive(win)) win.destroy();
    }
  }

  function openWindows() {
    const config = getConfig();
    const displays = config.screens === 'main' ? [screen.getPrimaryDisplay()] : screen.getAllDisplays();
    const primaryId = screen.getPrimaryDisplay().id;

    for (const display of displays) {
      const { x, y, width, height } = display.bounds;
      const win = new BrowserWindow({
        x,
        y,
        width,
        height,
        frame: false,
        fullscreen: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        show: false,
        title: 'Daily Planner reminder',
        backgroundColor: config.appearance.backgroundColor,
        webPreferences: {
          preload: preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      win.setMenuBarVisibility(false);
      win.setAlwaysOnTop(true, 'screen-saver'); // above ordinary windows and the taskbar
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', (event) => event.preventDefault());
      win.loadFile(pagePath);

      win.once('ready-to-show', () => {
        if (!alive(win)) return;
        win.show();
        if (display.id === primaryId) win.focus();
      });
      win.on('closed', () => {
        windows = windows.filter((w) => w !== win);
        // Closed some other way (for example Alt+F4) on the last remaining screen: treat it as "Got it".
        if (windows.length === 0) {
          items = [];
          guardMs = GUARD_FIRST_MS;
        }
      });
      windows.push(win);
    }
  }

  return {
    // Adds tasks that are starting now. Opens the windows if they are not open yet.
    show(newItems) {
      let added = 0;
      for (const item of newItems) {
        if (items.some((existing) => existing.id === item.id)) continue;
        items.push(item);
        added += 1;
      }
      if (added === 0) return;
      if (windows.length === 0) {
        guardMs = GUARD_FIRST_MS;
        openWindows();
      } else {
        broadcast();
      }
    },

    // The page asks for what to draw (once it has loaded).
    sendTo(webContents) {
      if (webContents && !webContents.isDestroyed()) webContents.send('alert-render', payload());
    },

    owns(webContents) {
      return windows.some((win) => alive(win) && win.webContents === webContents);
    },

    find(itemId) {
      return items.find((i) => i.id === itemId) || null;
    },

    // Takes a task off the queue. Closes everything when none are left.
    remove(itemId) {
      items = items.filter((i) => i.id !== itemId);
      guardMs = GUARD_NEXT_MS;
      if (items.length === 0) closeAll();
      else broadcast();
    },

    closeAll,
    isOpen: () => windows.length > 0,
    count: () => items.length,
    queue: () => items.slice(),
  };
}

function isValidAction(type) {
  return ACTIONS.includes(type);
}

module.exports = { createAlertManager, isValidAction, ACTIONS, GUARD_FIRST_MS, GUARD_NEXT_MS };
