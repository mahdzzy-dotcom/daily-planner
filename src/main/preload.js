'use strict';

// The only bridge between the window and the rest of the app.
// The window can call a fixed list of planner actions and listen for a few events; nothing else.

const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = ['data-changed', 'missed', 'open-task'];

contextBridge.exposeInMainWorld('api', {
  call: (method, ...args) => ipcRenderer.invoke('svc', method, args),
  exportData: () => ipcRenderer.invoke('export-data'),
  importData: () => ipcRenderer.invoke('import-data'),
  testNotification: () => ipcRenderer.invoke('test-notification'),
  previewAlert: () => ipcRenderer.invoke('preview-alert'),
  on: (channel, callback) => {
    if (!EVENTS.includes(channel)) return;
    ipcRenderer.on(channel, (event, payload) => callback(payload));
  },
  ready: () => ipcRenderer.send('renderer-ready'),
});
