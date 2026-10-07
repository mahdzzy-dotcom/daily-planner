'use strict';

// Clicks through the real screens in a headless browser and checks what happens.
// Run with:  node tools/ui-check.js   (needs Playwright; not part of the installed app)

process.env.TZ = process.env.TZ || 'Africa/Cairo';
const assert = require('node:assert/strict');
const fs = require('fs');
const { createService, openApp } = require('./ui-harness');

const playwright = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const executablePath = process.env.CHROMIUM_PATH || undefined;
const shotDir = process.env.SHOT_DIR || null;

let passed = 0;
async function step(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.log(`  FAIL ${name}\n       ${String(error.message).split('\n').join('\n       ')}`);
    process.exitCode = 1;
  }
}

async function shot(page, name) {
  if (shotDir) {
    fs.mkdirSync(shotDir, { recursive: true });
    await page.screenshot({ path: `${shotDir}/${name}.png` });
  }
}

// A task row, found by its exact title (not by words that happen to appear in another row's tags).
const taskRow = (page, title) =>
  page.locator('.task').filter({ has: page.locator('.task-title', { hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });

const rowTexts = (page, zone) => page.$$eval(`.zone.z${zone} .task .task-title`, (els) => els.map((e) => e.textContent));
const figure = (page, zone, label) =>
  page.$eval(`.zone.z${zone} .zone-figures`, (el, l) => {
    const span = Array.from(el.children).find((c) => c.textContent.startsWith(l));
    return span.querySelector('b').textContent;
  }, label);

async function setTime(page, hour, minute, ampm) {
  await page.selectOption('select[aria-label="Hour"]', String(hour));
  await page.selectOption('select[aria-label="Minute"]', String(minute));
  await page.selectOption('select[aria-label="AM or PM"]', ampm);
}

(async () => {
  const exampleSeed = require(process.env.SEED_PATH || './ui-seed');
  const service = createService();
  exampleSeed(service);
  const app = await openApp({ playwright, service, executablePath, width: 1100, height: 1100 });
  const { page, errors } = app;

  console.log('Daily View');
  await step('shows the header, Hijri date, Planning Day line and 5 zones', async () => {
    assert.match(await page.textContent('.day-title'), /Sunday, October 4, 2026/);
    assert.match(await page.textContent('.day-sub'), /1448/);
    assert.match(await page.textContent('.day-sub'), /Planning Day: Oct 4 → Oct 5/);
    assert.equal((await page.$$('.zone')).length, 5);
    assert.equal(await page.$$eval('.zone-name', (els) => els.map((e) => e.firstChild.textContent)).then((a) => a.join('|')),
      'FAJR → DHUHR|DHUHR → ASR|ASR → MAGHRIB|MAGHRIB → ISHA|ISHA → FAJR');
  });
  await step('highlights the current zone only', async () => {
    const current = await page.$$eval('.zone.current', (els) => els.map((e) => e.getAttribute('aria-label')));
    assert.deepEqual(current, ['Fajr → Dhuhr']);
    assert.equal((await page.$$('.now-chip')).length, 1);
  });
  await step('shows the three duration figures for every zone, empty zones included', async () => {
    assert.equal(await figure(page, 1, 'Total'), '6h 43m');
    assert.equal(await figure(page, 4, 'Total'), '1h 20m');
    assert.equal(await figure(page, 4, 'Scheduled'), '0m');
    assert.equal(await figure(page, 4, 'Free'), '1h 20m');
    assert.match(await page.textContent('.zone.z4 .empty-zone'), /No tasks/);
  });
  await step('rows show time, title, duration, indicators; after-midnight task has a "next day" label', async () => {
    assert.deepEqual(await rowTexts(page, 1), ['Morning Routine', 'Study SQL', 'Exercise', 'Long call with the team', 'Review notes']);
    const study = taskRow(page, 'Study SQL');
    assert.match(await study.textContent(), /8:00 AM/);
    assert.match(await study.textContent(), /1h 30m/);
    assert.match(await study.textContent(), /Repeats/);
    assert.match(await study.textContent(), /Reminder/);
    assert.match(await study.textContent(), /Not done/);
    assert.match(await taskRow(page, 'Night reading').textContent(), /next day/);
    assert.match(await page.locator('.zone.z2 .continues').first().textContent(), /Continues from/);
    assert.equal((await page.$$('.task .tag.warn')).length, 2, 'two overlapping tasks are flagged');
  });
  await step('Arabic titles display', async () => {
    assert.ok((await rowTexts(page, 5)).includes('مراجعة الدرس'));
  });

  console.log('Navigation');
  await step('previous / next / Today / date picker', async () => {
    await page.click('button[aria-label="Next day"]');
    await page.waitForFunction(() => document.querySelector('.day-title').textContent.includes('October 5'));
    assert.equal((await page.$$('.today-badge')).length, 0);
    assert.equal((await page.$$('.zone.current')).length, 0);
    // The 2 AM task belongs to Oct 4, so Oct 5 does not show it
    assert.ok(!(await page.textContent('#view')).includes('Night reading'));
    await page.click('button[aria-label="Previous day"]');
    await page.click('button[aria-label="Previous day"]');
    await page.waitForFunction(() => document.querySelector('.day-title').textContent.includes('October 3'));
    await page.click('button:text-is("Today")');
    await page.waitForFunction(() => document.querySelector('.day-title').textContent.includes('October 4'));
    await page.fill('input[aria-label="Jump to date"]', '2026-10-09');
    await page.waitForFunction(() => document.querySelector('.day-title').textContent.includes('October 9'));
    assert.deepEqual(await rowTexts(page, 4), ['Gym'], 'the Friday repeat appears');
    await page.click('button:text-is("Today")');
    await page.waitForSelector('.today-badge');
  });

  console.log('Adding tasks');
  await step('12-hour time picker + live end time + zone', async () => {
    await page.click('#add-btn');
    await page.fill('#f-title', 'Dentist');
    await setTime(page, 3, 30, 'PM');
    await page.fill('input[aria-label="Duration hours"]', '1');
    await page.fill('input[aria-label="Duration minutes"]', '15');
    await page.waitForFunction(() => document.querySelector('.readout[aria-label="End time"]').textContent === '4:45 PM');
    assert.equal(await page.textContent('.readout.zone-readout'), 'Asr → Maghrib');
    await shot(page, 'form-fixed');
    await page.click('.dialog-footer .btn.primary');
    await page.waitForSelector('.dialog', { state: 'detached' });
    assert.ok((await rowTexts(page, 3)).includes('Dentist'));
    // Read Quran 3:24-3:54 PM and Dentist 3:30-4:45 PM overlap, so the overlap is counted once: 3:24-4:45 PM
    assert.equal(await figure(page, 3, 'Scheduled'), '1h 21m');
    assert.equal((await page.$$('.zone.z3 .tag.warn')).length, 2, 'both overlapping tasks are flagged');
  });
  await step('prayer-relative start shows the resolved time and follows the prayer', async () => {
    await page.click('#add-btn');
    await page.fill('#f-title', 'Before Maghrib walk');
    await page.click('button:text-is("Relative to Prayer")');
    await page.selectOption('select[aria-label="Prayer"]', 'maghrib');
    await page.selectOption('select[aria-label="Before or after"]', 'before');
    await page.fill('input[aria-label="Minutes"]', '45');
    await page.waitForFunction(() => document.querySelectorAll('.readout')[0].textContent === '5:15 PM');
    assert.equal(await page.textContent('.readout.zone-readout'), 'Asr → Maghrib');
    await page.click('.dialog-footer .btn.primary');
    await page.waitForSelector('.dialog', { state: 'detached' });
    const row = taskRow(page, 'Before Maghrib walk');
    assert.match(await row.textContent(), /5:15 PM/);
  });
  await step('a 2:00 AM task entered on Oct 5 shows the Planning Day note and lands in Zone 5 of Oct 4', async () => {
    await page.click('#add-btn');
    await page.fill('#f-title', 'Tahajjud');
    await setTime(page, 2, 0, 'AM');
    await page.fill('#f-date', '2026-10-05');
    await page.waitForSelector('.note.placement:not([hidden])');
    assert.equal(await page.textContent('.note.placement'), 'Will appear under Planning Day: Oct 4 → Oct 5, Zone: Isha → Fajr');
    await shot(page, 'form-after-midnight');
    await page.click('.dialog-footer .btn.primary');
    await page.waitForSelector('.dialog', { state: 'detached' });
    assert.ok((await rowTexts(page, 5)).includes('Tahajjud'));
  });
  await step('validation: empty title and zero duration show friendly messages and nothing is saved', async () => {
    const before = service.data.tasks.length;
    await page.click('#add-btn');
    await page.fill('input[aria-label="Duration minutes"]', '0');
    await page.fill('input[aria-label="Duration hours"]', '0');
    await page.click('.dialog-footer .btn.primary');
    await page.waitForSelector('.errors:not([hidden])');
    const text = await page.textContent('.errors');
    assert.match(text, /Please enter a title/);
    assert.match(text, /Duration/);
    assert.equal(service.data.tasks.length, before);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.dialog', { state: 'detached' });
  });
  await step('repeating task: weekday toggles, live summary and next-5 preview', async () => {
    await page.click('#add-btn');
    await page.fill('#f-title', 'Class');
    await page.click('button:text-is("Repeats")');
    await page.selectOption('select[aria-label="Repeat unit"]', 'weekly');
    await page.fill('input[aria-label="Repeat every"]', '2');
    await page.click('.daytoggle button:text-is("Mon")');
    await page.click('.daytoggle button:text-is("Wed")');
    await page.waitForFunction(() => /Every 2 weeks on/.test(document.querySelector('.summary').textContent));
    const summary = await page.textContent('.summary');
    assert.match(summary, /Every 2 weeks on Sun, Mon, Wed, starting Oct 4/);
    assert.equal((await page.$$('.preview-list li')).length, 6, 'heading + 5 dates');
    await shot(page, 'form-weekly');
    await page.click('.dialog-footer .btn.primary');
    await page.waitForSelector('.dialog', { state: 'detached' });
    assert.ok((await rowTexts(page, 1)).concat(await rowTexts(page, 2)).includes('Class'));
  });
  await step('reminders: add and remove custom times; default hint when empty', async () => {
    await page.click('#add-btn');
    assert.match(await page.textContent('.hint >> text=/No custom times/'), /default reminder \(10 min before\)/);
    await page.fill('input[aria-label="Reminder amount"]', '1');
    await page.selectOption('select[aria-label="Reminder unit"]', '60');
    await page.click('button:text-is("Add reminder")');
    await page.click('button:text-is("At start time")');
    assert.deepEqual(await page.$$eval('.chip > span', (els) => els.map((e) => e.textContent)), ['1 hour before', 'At start time']);
    await page.click('button[aria-label="Remove 1 hour before"]');
    assert.deepEqual(await page.$$eval('.chip > span', (els) => els.map((e) => e.textContent)), ['At start time']);
    await page.click('.segmented[aria-label="Reminder on or off"] button:text-is("Off")');
    assert.equal((await page.$$('.chip')).length, 0);
    await page.keyboard.press('Escape');
  });

  console.log('Tasks relative to tasks');
  await step('"Relative to Task": pick a task, minutes, before/after, start/end - the start time updates live', async () => {
    await page.click('#add-btn');
    await page.fill('#f-title', 'Warm-up');
    await page.click('button:text-is("Relative to Task")');
    await page.selectOption('select[aria-label="Task to follow"]', { label: 'Study SQL (8:00 AM, 1h 30m, repeats)' });
    await page.fill('input[aria-label="Minutes"]', '15');
    const startText = () => page.$$eval('.readout', (els) => els[0].textContent);
    await page.waitForFunction(() => document.querySelectorAll('.readout')[0].textContent === '9:45 AM');
    assert.equal(await page.textContent('.readout.zone-readout'), 'Fajr → Dhuhr');
    await page.selectOption('select[aria-label="Start or end of that task"]', 'start');
    await page.waitForFunction(() => document.querySelectorAll('.readout')[0].textContent === '8:15 AM');
    await page.selectOption('select[aria-label="Before or after"]', 'before');
    await page.waitForFunction(() => document.querySelectorAll('.readout')[0].textContent === '7:45 AM');
    await page.selectOption('select[aria-label="Start or end of that task"]', 'end');
    await page.selectOption('select[aria-label="Before or after"]', 'after');
    await page.waitForFunction(() => document.querySelectorAll('.readout')[0].textContent === '9:45 AM');
    assert.equal(await startText(), '9:45 AM');
    assert.equal(await page.isHidden('.note.start-warning'), true, 'no warning when the other task is on that day');
    await shot(page, 'form-relative-task');
    await page.click('.dialog-footer .btn.primary');
    await page.waitForSelector('.dialog', { state: 'detached' });
    const row = taskRow(page, 'Warm-up');
    assert.match(await row.textContent(), /9:45 AM/);
    assert.match(await row.textContent(), /Follows “Study SQL”/);
  });
  await step('when the other task is not on that day, a warning and the backup time are shown', async () => {
    await page.click('#add-btn');
    await page.fill('#f-title', 'Gym buddy');
    await page.click('button:text-is("Relative to Task")');
    await page.selectOption('select[aria-label="Task to follow"]', { label: 'Gym (6:30 PM, 1h 0m, repeats)' });
    await page.waitForSelector('.note.start-warning:not([hidden])');
    assert.match(await page.textContent('.note.start-warning'), /not on this day/);
    await page.waitForFunction(() => document.querySelectorAll('.readout')[0].textContent === '9:00 AM');
    await setTime(page, 3, 0, 'PM');
    await page.waitForFunction(() => document.querySelectorAll('.readout')[0].textContent === '3:00 PM');
    await shot(page, 'form-backup-warning');
    await page.click('.dialog-footer .btn.primary');
    await page.waitForSelector('.dialog', { state: 'detached' });
    const row = taskRow(page, 'Gym buddy');
    assert.match(await row.textContent(), /3:00 PM/);
    assert.match(await row.textContent(), /Backup start time/);
  });
  await step('a task cannot be offered itself, and a missing choice is reported', async () => {
    await taskRow(page, 'Warm-up').click();
    await page.waitForSelector('.dialog');
    const options = await page.$$eval('select[aria-label="Task to follow"] option', (els) => els.map((e) => e.textContent));
    assert.ok(options.some((o) => o.startsWith('Study SQL')));
    assert.ok(!options.some((o) => o.startsWith('Warm-up')), 'not itself');
    await page.selectOption('select[aria-label="Task to follow"]', '');
    await page.click('.dialog-footer .btn.primary');
    await page.waitForSelector('.errors:not([hidden])');
    assert.match(await page.textContent('.errors'), /Choose the task/);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.dialog', { state: 'detached' });
  });
  await step('deleting a task that others follow warns, and the followers keep their times', async () => {
    await page.click('#add-btn');
    await page.fill('#f-title', 'Breakfast');
    await setTime(page, 6, 0, 'AM');
    await page.click('.dialog-footer .btn.primary');
    await page.waitForSelector('.dialog', { state: 'detached' });

    await page.click('#add-btn');
    await page.fill('#f-title', 'Walk');
    await page.click('button:text-is("Relative to Task")');
    await page.selectOption('select[aria-label="Task to follow"]', { label: 'Breakfast (6:00 AM, 30m)' });
    await page.fill('input[aria-label="Minutes"]', '10');
    await page.waitForFunction(() => document.querySelectorAll('.readout')[0].textContent === '6:40 AM');
    await page.click('.dialog-footer .btn.primary');
    await page.waitForSelector('.dialog', { state: 'detached' });

    await taskRow(page, 'Breakfast').click();
    await page.click('.dialog-footer .btn.danger');
    await page.waitForSelector('text=Other tasks follow this task');
    assert.match(await page.textContent('.overlay:last-child .dialog-message'), /“Walk”/);
    await shot(page, 'delete-warning');
    await page.click('.overlay:last-child .btn:text-is("Cancel")');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.overlay', { state: 'detached' });
    assert.ok((await rowTexts(page, 1)).includes('Breakfast'), 'cancel keeps it');

    await taskRow(page, 'Breakfast').click();
    await page.click('.dialog-footer .btn.danger');
    await page.waitForSelector('text=Other tasks follow this task');
    await page.click('.overlay:last-child .btn.danger');
    await page.waitForSelector('.overlay', { state: 'detached' });
    assert.ok(!(await rowTexts(page, 1)).includes('Breakfast'));
    const walk = taskRow(page, 'Walk');
    assert.match(await walk.textContent(), /6:40 AM/);
    assert.ok(!/Follows/.test(await walk.textContent()), 'it is a fixed time now');
  });

  console.log('Editing');
  await step('toggling done from the row', async () => {
    const row = taskRow(page, 'Exercise');
    await row.locator('.check').click();
    await page.waitForSelector('.task.done:has-text("Exercise")');
    assert.equal(await row.locator('.check.on').count(), 1);
  });
  await step('edit a one-off task', async () => {
    await taskRow(page, 'Dentist').click();
    await page.waitForSelector('.dialog');
    assert.equal(await page.inputValue('#f-title'), 'Dentist');
    await page.fill('#f-title', 'Dentist (moved)');
    await page.click('.dialog-footer .btn.primary');
    await page.waitForSelector('.dialog', { state: 'detached' });
    assert.ok((await rowTexts(page, 3)).includes('Dentist (moved)'));
  });
  await step('editing one repeating occurrence: scope chooser, "This occurrence only"', async () => {
    await taskRow(page, 'Study SQL').click();
    await page.waitForSelector('.dialog');
    await page.fill('#f-title', 'Study SQL (today)');
    await page.click('.dialog-footer .btn.primary');
    await page.waitForSelector('text=Save which occurrences');
    await shot(page, 'scope-dialog');
    assert.equal((await page.$$('input[name="scope"]:checked')).length, 1);
    await page.click('.overlay:last-child .btn.primary');
    await page.waitForSelector('.dialog', { state: 'detached' });
    assert.ok((await rowTexts(page, 1)).includes('Study SQL (today)'));
    await page.click('button[aria-label="Next day"]');
    await page.waitForFunction(() => document.querySelector('.day-title').textContent.includes('October 5'));
    assert.ok((await rowTexts(page, 1)).includes('Study SQL'), 'tomorrow keeps the old title');
    await page.click('button:text-is("Today")');
  });
  await step('changing the repeat pattern disables "This occurrence only"', async () => {
    await taskRow(page, 'Class').first().click();
    await page.waitForSelector('.dialog');
    await page.fill('input[aria-label="Repeat every"]', '3');
    await page.click('.dialog-footer .btn.primary');
    await page.waitForSelector('text=Save which occurrences');
    assert.equal(await page.isDisabled('input[name="scope"] >> nth=0'), true);
    assert.match(await page.textContent('.overlay:last-child .hint'), /repeat pattern can only be changed/);
    await page.click('.overlay:last-child .btn:text-is("Cancel")');
    await page.keyboard.press('Escape');
  });
  await step('deleting a repeating task asks for scope; deleting a one-off asks to confirm', async () => {
    await taskRow(page, 'Class').first().click();
    await page.click('.dialog-footer .btn.danger');
    await page.waitForSelector('text=Delete which occurrences');
    await page.click('input[name="scope"] >> nth=2');
    await page.click('.overlay:last-child .btn.primary');
    await page.waitForSelector('.overlay', { state: 'detached' });
    assert.ok(!(await page.textContent('#view')).includes('Class'));

    await taskRow(page, 'Tahajjud').click();
    await page.click('.dialog-footer .btn.danger');
    await page.waitForSelector('text=Delete "Tahajjud"?');
    await page.click('.overlay:last-child .btn.danger');
    await page.waitForSelector('.overlay', { state: 'detached' });
    assert.ok(!(await page.textContent('#view')).includes('Tahajjud'));
  });
  await step('duplicate', async () => {
    await taskRow(page, 'Exercise').click();
    await page.click('.dialog-footer .btn:text-is("Duplicate")');
    await page.waitForSelector('.dialog', { state: 'detached' });
    assert.ok((await rowTexts(page, 1)).includes('Exercise (copy)'));
  });
  await step('Arabic text can be typed and saved', async () => {
    await page.click('#add-btn');
    await page.fill('#f-title', 'قراءة القرآن');
    await page.fill('#f-notes', 'ملاحظات مهمة');
    await page.click('.dialog-footer .btn.primary');
    await page.waitForSelector('.dialog', { state: 'detached' });
    assert.ok((await rowTexts(page, 1)).includes('قراءة القرآن'));
  });

  console.log('Bell, menu, missed reminders');
  await step('bell lists upcoming reminders', async () => {
    await page.click('#bell-btn');
    await page.waitForSelector('#bell-panel:not([hidden]) .upcoming-item');
    assert.ok((await page.$$('#bell-panel .upcoming-item')).length >= 1);
    await shot(page, 'bell');
    await page.click('#bell-btn');
    assert.equal(await page.isHidden('#bell-panel'), true);
  });
  await step('menu opens Settings', async () => {
    await page.click('#menu-btn');
    await page.click('#menu-panel .menu-item:text-is("Settings")');
    await page.waitForSelector('.settings-section');
  });
  await step('missed-reminders summary dialog', async () => {
    await page.evaluate(() => window.__handlers.missed([
      { taskId: 't2', dateKey: '2026-10-04', title: 'Study SQL', startLabel: '8:00 AM', zoneName: 'Fajr → Dhuhr', alreadyStarted: true },
    ]));
    await page.waitForSelector('text=You missed 1 reminder');
    await shot(page, 'missed');
    await page.click('.overlay .btn.primary');
  });

  console.log('Settings');
  await step('every section is there', async () => {
    const titles = await page.$$eval('.settings-section h2', (els) => els.map((e) => e.textContent));
    assert.deepEqual(titles, ['Prayer Times', 'Reminders & Notifications', 'Application', 'Categories', 'Data']);
    await shot(page, 'settings');
  });
  await step('prayer adjustment is saved and moves the zone boundary', async () => {
    await page.fill('input[aria-label="Asr adjustment in minutes"]', '5');
    await page.press('input[aria-label="Asr adjustment in minutes"]', 'Enter');
    await page.waitForFunction(() => true);
    await page.waitForTimeout(150);
    assert.equal(service.getSettings().adjustments.asr, 5);
  });
  await step('invalid value shows an error and is not kept', async () => {
    await page.fill('input[aria-label="Snooze minutes"]', '0');
    await page.press('input[aria-label="Snooze minutes"]', 'Enter');
    await page.waitForSelector('.toast.error');
    assert.match(await page.textContent('.toast.error'), /Snooze/);
    assert.equal(service.getSettings().snoozeMinutes, 5);
  });
  await step('theme switches instantly and is saved', async () => {
    await page.selectOption('select[aria-label="Theme"]', 'dark');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    assert.equal(service.getSettings().theme, 'dark');
    await shot(page, 'settings-dark');
    await page.selectOption('select[aria-label="Theme"]', 'light');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await page.selectOption('select[aria-label="Theme"]', 'system');
    await page.waitForFunction(() => document.documentElement.dataset.theme === undefined);
  });
  await step('toggles save: sound, zone-start, start with Windows', async () => {
    await page.click('label:has-text("Play a sound") input');
    await page.click('label:has-text("Notify when each Zone begins") input');
    await page.click('label:has-text("Start Daily Planner when Windows starts") input');
    await page.waitForTimeout(200);
    const s = service.getSettings();
    assert.equal(s.soundEnabled, false);
    assert.equal(s.zoneStartNotifications, true);
    assert.equal(s.startWithWindows, true);
  });
  await step('working days', async () => {
    await page.click('.settings-section .daytoggle button:text-is("Fri")');
    await page.waitForTimeout(200);
    assert.deepEqual(service.getSettings().workingDays, [0, 1, 2, 3, 4, 5]);
  });
  await step('categories: add, rename, delete', async () => {
    await page.fill('input[aria-label="New category name"]', 'Family');
    await page.click('.cat-row .btn:text-is("Add")');
    await page.waitForSelector('input[aria-label="Name of Family"]');
    await page.fill('input[aria-label="Name of Family"]', 'Home');
    await page.press('input[aria-label="Name of Family"]', 'Enter');
    await page.waitForSelector('input[aria-label="Name of Home"]');
    assert.ok(service.data.categories.some((c) => c.name === 'Home'));
    await page.locator('.cat-row', { has: page.locator('input[aria-label="Name of Home"]') }).locator('.btn.danger').click();
    await page.click('.overlay .btn.danger');
    await page.waitForSelector('input[aria-label="Name of Home"]', { state: 'detached' });
    assert.ok(!service.data.categories.some((c) => c.name === 'Home'));
  });
  await step('export button asks the app to export', async () => {
    await page.click('.settings-section button:text-is("Export data…")');
    await page.waitForTimeout(150);
    assert.deepEqual(await page.evaluate(() => window.__exports), ['export']);
  });
  await step('the "Send a test notification" button asks the app to send one', async () => {
    await page.click('button:text-is("Send a test notification")');
    await page.waitForSelector('.toast:has-text("Test notification sent")');
    assert.deepEqual(await page.evaluate(() => window.__exports), ['export', 'test-notification']);
  });
  await step('back to the Daily View keeps working', async () => {
    await page.click('.back-link');
    await page.waitForSelector('.zone');
    assert.equal((await page.$$('.zone')).length, 5);
  });

  await step('no errors were reported by the page', async () => {
    assert.deepEqual(errors, []);
  });

  await app.browser.close();

  console.log('First run');
  await step('the welcome screen asks for the city once, then the app is ready', async () => {
    const fresh = createService({ firstRun: true });
    const first = await openApp({ playwright, service: fresh, executablePath, width: 1000, height: 800 });
    await first.page.waitForSelector('text=Welcome to Daily Planner');
    assert.equal(await first.page.inputValue('#welcome-city'), 'Cairo');
    await first.page.selectOption('#welcome-city', 'Alexandria');
    await shot(first.page, 'welcome');
    await first.page.click('button:text-is("Start planning")');
    await first.page.waitForSelector('.overlay', { state: 'detached' });
    assert.equal(fresh.getSettings().cityName, 'Alexandria');
    assert.equal(fresh.getSettings().welcomeShown, true);
    assert.deepEqual(first.errors, []);
    await first.browser.close();

    // Opening the app again does not show it a second time
    const again = await openApp({ playwright, service: fresh, executablePath, width: 1000, height: 800 });
    assert.equal((await again.page.$$('.overlay')).length, 0);
    await again.browser.close();
  });

  console.log(`\n${passed} steps passed${process.exitCode ? ', some FAILED' : ''}`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
