'use strict';

// Windows notification ("toast") adapter for the Electron main process.
//
// It turns the plain notification payloads made by src/core/reminders.js into native Windows
// toasts with Snooze / Mark as Done buttons.
//
// How button clicks reach the app: every button (and a click on the toast itself) opens a
// small link such as  dailyplanner://snooze?task=gym&date=2026-10-05 .  Windows hands that link
// to the app (the installer registers the "dailyplanner" protocol), the already-running copy
// receives it through Electron's single-instance "second-instance" event, and
// parseActionUrl() below turns it back into an action for ReminderEngine.handleAction().
//
// The Electron pieces are passed in (not imported), so this file can be tested without Electron.

const { isValidKey } = require('../core/time');

const PROTOCOL = 'dailyplanner';
const APP_ID = 'com.dailyplanner.app'; // call app.setAppUserModelId(APP_ID) at startup
const ACTION_TYPES = ['snooze', 'done', 'open', 'missed'];

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildActionUrl(type, target = {}) {
  const params = new URLSearchParams();
  if (target.taskId) params.set('task', target.taskId);
  if (target.dateKey) params.set('date', target.dateKey);
  const query = params.toString();
  return `${PROTOCOL}://${type}${query ? `?${query}` : ''}`;
}

// Returns { type, taskId, dateKey } or null when the text is not one of our links.
function parseActionUrl(text) {
  if (typeof text !== 'string' || !text.toLowerCase().startsWith(`${PROTOCOL}://`)) return null;
  let url;
  try {
    url = new URL(text);
  } catch (error) {
    return null;
  }
  const type = url.hostname.toLowerCase();
  if (!ACTION_TYPES.includes(type)) return null;

  const taskId = url.searchParams.get('task') || null;
  const dateKey = url.searchParams.get('date') || null;
  if (dateKey !== null && !isValidKey(dateKey)) return null;
  if ((type === 'snooze' || type === 'done') && (!taskId || !dateKey)) return null;
  return { type, taskId, dateKey };
}

// When Windows opens the app with a link, it appears among the command-line arguments.
function findActionUrlInArgv(argv) {
  const link = (argv || []).find((arg) => typeof arg === 'string' && arg.toLowerCase().startsWith(`${PROTOCOL}://`));
  return link ? parseActionUrl(link) : null;
}

function buildToastXml(payload) {
  const lines = Array.isArray(payload.lines) ? payload.lines : [];
  const launch = payload.kind === 'missed' ? buildActionUrl('missed') : buildActionUrl('open', payload);

  let xml = `<toast launch="${escapeXml(launch)}" activationType="protocol">`;
  xml += '<visual><binding template="ToastGeneric">';
  xml += `<text>${escapeXml(payload.title)}</text>`;
  for (const line of lines) xml += `<text>${escapeXml(line)}</text>`;
  xml += '</binding></visual>';
  if (payload.silent) xml += '<audio silent="true"/>';

  if (Array.isArray(payload.actions) && payload.actions.length > 0) {
    xml += '<actions>';
    for (const action of payload.actions) {
      xml += `<action content="${escapeXml(action.label)}" arguments="${escapeXml(buildActionUrl(action.type, payload))}" activationType="protocol"/>`;
    }
    xml += '</actions>';
  }
  xml += '</toast>';
  return xml;
}

// electron: the object with Notification, e.g. require('electron').
// Returns notify(payload), which ReminderEngine uses as deps.notify.
function createElectronNotifier({ Notification, onError }) {
  const alive = new Set(); // keeps notifications from being cleaned up while on screen

  return function notify(payload) {
    if (typeof Notification.isSupported === 'function' && !Notification.isSupported()) return null;

    const notification = new Notification({
      title: payload.title,
      body: payload.body,
      silent: Boolean(payload.silent),
      toastXml: buildToastXml(payload),
    });

    alive.add(notification);
    const release = () => alive.delete(notification);
    notification.on('close', release);
    notification.on('click', release);
    notification.on('failed', (event, error) => {
      release();
      if (onError) onError(error || event);
    });
    notification.show();
    return notification;
  };
}

module.exports = {
  PROTOCOL,
  APP_ID,
  escapeXml,
  buildActionUrl,
  parseActionUrl,
  findActionUrlInArgv,
  buildToastXml,
  createElectronNotifier,
};
