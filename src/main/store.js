'use strict';

// Saves the app's data to one JSON file in the user's profile folder.
// Writes are crash-safe: the new data goes to a temporary file first, is flushed to disk, and only
// then replaces the real file. The previous version is kept as a ".bak" copy.

const fs = require('fs');
const path = require('path');
const { emptyData, normalizeData } = require('../core/data');

class FileStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.backupPath = `${filePath}.bak`;
    this.tempPath = `${filePath}.tmp`;
    this.loadNotes = []; // things the app may want to tell the user after loading
  }

  readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  // Returns the saved data, or fresh default data on first run.
  // A damaged data file is set aside (not deleted) and the backup copy is used instead.
  load() {
    this.loadNotes = [];
    if (!fs.existsSync(this.filePath) && !fs.existsSync(this.backupPath)) return emptyData();

    for (const [file, label] of [[this.filePath, 'main'], [this.backupPath, 'backup']]) {
      if (!fs.existsSync(file)) continue;
      try {
        const { data, warnings } = normalizeData(this.readJson(file));
        this.loadNotes.push(...warnings);
        if (label === 'backup') this.loadNotes.push('Your data file was damaged, so the last backup copy was loaded.');
        return data;
      } catch (error) {
        if (label === 'main') this.setAsideDamagedFile();
      }
    }
    this.loadNotes.push('Your data file could not be read, so the app started empty.');
    return emptyData();
  }

  setAsideDamagedFile() {
    try {
      fs.renameSync(this.filePath, `${this.filePath}.damaged-${Date.now()}`);
    } catch (error) {
      // nothing more we can do
    }
  }

  save(data) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const text = JSON.stringify(data, null, 2);

    const fd = fs.openSync(this.tempPath, 'w');
    try {
      fs.writeSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    if (fs.existsSync(this.filePath)) {
      try {
        fs.copyFileSync(this.filePath, this.backupPath);
      } catch (error) {
        // a missing backup should never block saving
      }
    }
    fs.renameSync(this.tempPath, this.filePath);
  }
}

// A store that keeps everything in memory. Used by tests and the screenshot tool.
class MemoryStore {
  constructor(initial) {
    this.data = initial || emptyData();
    this.saveCount = 0;
    this.loadNotes = [];
  }

  load() {
    return JSON.parse(JSON.stringify(this.data));
  }

  save(data) {
    this.data = JSON.parse(JSON.stringify(data));
    this.saveCount += 1;
  }
}

module.exports = { FileStore, MemoryStore };
