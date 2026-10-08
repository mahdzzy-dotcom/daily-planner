'use strict';

// Opens the real screens in a headless browser, connected to the real planner service,
// so the screens can be tested and photographed without Windows or Electron.
// Not part of the installed app. Needs Playwright (only available where it is installed).

const path = require('path');
const { PlannerService, PUBLIC_METHODS } = require('../src/main/service');
const { MemoryStore } = require('../src/main/store');
const { parseDateKey } = require('../src/core/time');

function at(key, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = parseDateKey(key);
  d.setHours(h, m, 0, 0);
  return d;
}

// Prayer times of the spec's example day, for every date.
function exampleProvider(key) {
  return {
    fajr: at(key, '05:05'), dhuhr: at(key, '11:48'), asr: at(key, '15:14'), maghrib: at(key, '18:00'), isha: at(key, '19:20'),
  };
}

function createService(options = {}) {
  let counter = 0;
  const service = new PlannerService({
    store: new MemoryStore(),
    now: () => options.now || at('2026-10-04', '10:00'),
    newId: () => `t${++counter}`,
    providerFactory: () => exampleProvider,
  });
  if (!options.firstRun) service.saveSettings({ welcomeShown: true });
  return service;
}

async function openApp({ playwright, service, colorScheme = 'light', width = 1100, height = 900, executablePath }) {
  const browser = await playwright.chromium.launch({ executablePath });
  const context = await browser.newContext({ viewport: { width, height }, colorScheme });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  const calls = [];
  await page.exposeFunction('__invoke', async (method, args) => {
    if (!PUBLIC_METHODS.includes(method)) throw new Error(`Not allowed: ${method}`);
    calls.push(method);
    return JSON.parse(JSON.stringify(await service[method](...args)));
  });
  await page.addInitScript(() => {
    window.__exports = [];
    window.api = {
      call: (method, ...args) => window.__invoke(method, args),
      exportData: async () => { window.__exports.push('export'); return { ok: true }; },
      importData: async () => ({ canceled: true }),
      testNotification: async () => { window.__exports.push('test-notification'); return { ok: true }; },
      previewAlert: async () => { window.__exports.push('preview-alert'); return { ok: true }; },
      on: (channel, cb) => { (window.__handlers = window.__handlers || {})[channel] = cb; },
    };
  });
  const file = path.resolve(__dirname, '../src/renderer/index.html');
  await page.goto(`file://${file}`);
  await page.waitForSelector('.zone');
  return { browser, context, page, errors, calls };
}

// Opens the full-screen reminder page on its own, with a stand-in for the main process.
// Call page.evaluate(() => window.__render(state)) to show something; button presses are collected in window.__actions.
async function openAlertPage({ playwright, executablePath, width = 1920, height = 1080 }) {
  const browser = await playwright.chromium.launch({ executablePath });
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.addInitScript(() => {
    window.__actions = [];
    window.alertApi = {
      onRender: (cb) => { window.__render = cb; },
      ready: () => { window.__ready = true; },
      action: (type, itemId) => window.__actions.push([type, itemId]),
    };
  });
  await page.goto(`file://${path.resolve(__dirname, '../src/renderer/alert.html')}`);
  await page.waitForFunction(() => window.__ready === true);
  return { browser, page, errors };
}

module.exports = { createService, openApp, openAlertPage, exampleProvider, at };
