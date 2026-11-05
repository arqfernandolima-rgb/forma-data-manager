'use strict';
/**
 * Small JSON files in the app's userData folder:
 *   settings.json    user choices (client ID, hub, data folder, schedule...)
 *   sync-state.json  the in-flight sync, so a restart can resume waiting on a job
 *   history.json     the last 50 sync runs
 *   tokens.bin       OAuth tokens, encrypted with Windows DPAPI via Electron safeStorage
 */
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SETTINGS = {
  clientId: '',
  callbackPort: 8642,
  hub: null, // { id, accountId, name, region }
  dataDir: '',
  schedule: { enabled: true, time: '06:00' },
  startAtLogin: true,
  keepVersions: 2,
  keepDownloads: false,
  disclaimerAcceptedAt: null,
  wizardComplete: false,
  ownedRequests: [], // Data Connector request IDs this app created (only these are ever deleted)
  lastScheduledRunDate: null, // 'YYYY-MM-DD' local date of the last scheduled attempt
};

class JsonStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }
  file(name) {
    return path.join(this.dir, name);
  }
  read(name, fallback) {
    try {
      return JSON.parse(fs.readFileSync(this.file(name), 'utf8'));
    } catch {
      return fallback;
    }
  }
  write(name, value) {
    const target = this.file(name);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, target);
  }
  settings() {
    const s = this.read('settings.json', {});
    return { ...DEFAULT_SETTINGS, ...s, schedule: { ...DEFAULT_SETTINGS.schedule, ...(s.schedule || {}) } };
  }
  updateSettings(patch) {
    const next = { ...this.settings(), ...patch };
    this.write('settings.json', next);
    return next;
  }
  history() {
    return this.read('history.json', []);
  }
  addHistory(entry) {
    const h = [entry, ...this.history()].slice(0, 50);
    this.write('history.json', h);
    return h;
  }
  syncState() {
    return this.read('sync-state.json', null);
  }
  setSyncState(state) {
    if (state == null) {
      try {
        fs.unlinkSync(this.file('sync-state.json'));
      } catch {}
    } else this.write('sync-state.json', state);
  }
}

module.exports = { JsonStore, DEFAULT_SETTINGS };
