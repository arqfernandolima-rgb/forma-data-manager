'use strict';
// Narrow, explicit bridge between the UI and the main process. No Node access in the page.
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('fdm', {
  state: call('state:get'),
  updateSettings: call('settings:update'),
  acceptDisclaimer: call('disclaimer:accept'),
  signIn: call('auth:signIn'),
  signOut: call('auth:signOut'),
  listHubs: call('hubs:list'),
  selectHub: call('hub:select'),
  manualHub: call('hub:manual'),
  pickDataDir: call('dataDir:pick'),
  checkDataDir: call('dataDir:check'),
  setDataDir: call('dataDir:set'),
  syncNow: call('sync:start'),
  cancelSync: call('sync:cancel'),
  useRejected: call('sync:useRejected'),
  discardRejected: call('sync:discardRejected'),
  rollback: call('db:rollback'),
  installClaude: call('claude:install'),
  uninstallClaude: call('claude:uninstall'),
  getSkill: call('skill:get'),
  saveSkillZip: call('skill:saveZip'),
  installSkillClaudeCode: call('skill:installClaudeCode'),
  completeWizard: call('wizard:complete'),
  openUrl: call('open:url'),
  openPath: call('open:path'),
  copy: call('clipboard:write'),
  onState: (fn) => {
    const h = (_e, s) => fn(s);
    ipcRenderer.on('state', h);
    return () => ipcRenderer.off('state', h);
  },
});
