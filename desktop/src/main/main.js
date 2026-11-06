'use strict';
/**
 * Forma Data Manager — Electron main process.
 * Unofficial community tool. Not an Autodesk product. Provided as is; see DISCLAIMER.md.
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, safeStorage, net, Notification, nativeImage, powerMonitor } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { JsonStore } = require('./store');
const { createLogger } = require('./log');
const { Auth, redirectUri } = require('./auth');
const { ApsClient } = require('./aps');
const { DataConnector } = require('./dataconnector');
const { Engine, engineCommand } = require('./engine');
const { SyncManager } = require('./sync');
const { Scheduler } = require('./scheduler');
const claudeConfig = require('./claude-config');
const skill = require('./skill');
const { trayState, TRAY_STATES } = require('./tray-state');

const APP_ID = 'io.github.arqfernandolima.formadatamanager';
const REPO_URL = 'https://github.com/arqfernandolima-rgb/forma-data-manager';
const ROOT = path.join(__dirname, '..', '..'); // desktop/
const startHidden = process.argv.includes('--hidden');
const LOGIN_ITEM_NAME = 'FormaDataManager'; // also referenced by build/installer.nsh

// Called by the uninstaller (not on upgrades): undo what we registered outside our folder.
if (process.argv.includes('--cleanup-before-uninstall')) {
  app.whenReady().then(() => {
    try {
      claudeConfig.uninstall();
    } catch {}
    try {
      app.setLoginItemSettings({ openAtLogin: false, name: LOGIN_ITEM_NAME });
    } catch {}
    app.exit(0);
  });
  return;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.setAppUserModelId(APP_ID);

let win = null;
let tray = null;
let quitting = false;
let ctx = null;

function defaultDataDir() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'FormaData');
}

function makeContext() {
  const store = new JsonStore(app.getPath('userData'));
  const log = createLogger(path.join(app.getPath('userData'), 'logs'));
  log.info(`Forma Data Manager ${app.getVersion()} starting (packaged=${app.isPackaged})`);
  const fetchImpl = (url, opts) => net.fetch(url, opts);
  const auth = new Auth({
    getSettings: () => store.settings(),
    tokenFile: path.join(app.getPath('userData'), 'tokens.bin'),
    safeStorage,
    openExternal: (u) => shell.openExternal(u),
    fetch: fetchImpl,
    log,
  });
  const aps = new ApsClient({ auth, fetch: fetchImpl, log });
  const dc = new DataConnector({ aps, fetch: fetchImpl, log });
  const where = { isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appRoot: ROOT };
  const engine = new Engine(engineCommand(where), log);
  // Scheduled syncs always notify. Manual ones only when you're not looking at the window,
  // since an extract can take an hour and you were told you could walk away.
  const notify = (title, body, { trigger } = {}) => {
    const watching = win && !win.isDestroyed() && win.isVisible() && win.isFocused();
    if (trigger === 'manual' && watching) return;
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, silent: false });
    n.on('click', showWindow);
    n.show();
  };
  const sync = new SyncManager({ store, auth, dc, engine, log, notify });
  const scheduler = new Scheduler({ store, sync, auth, log });
  return { store, log, auth, aps, dc, engine, sync, scheduler, skillDir: skill.skillSourceDir(where) };
}

function iconPath(name) {
  return path.join(ROOT, 'assets', name);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 880,
    minHeight: 620,
    title: 'Forma Data Manager',
    icon: iconPath('icon.png'),
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f6f6f4',
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (!(startHidden && ctx.store.settings().wizardComplete)) win.show();
  });
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    const s = ctx.store.settings();
    if (!s.trayNoticeShown && s.wizardComplete) {
      ctx.store.updateSettings({ trayNoticeShown: true });
      tray?.displayBalloon?.({ title: 'Still running', content: 'Forma Data Manager keeps running in the tray so the daily sync can happen. Right-click the tray icon to quit.' });
    }
  });
  // Links clicked inside the app open in the user's browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openSafe(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function showWindow() {
  if (!win) createWindow();
  win.show();
  win.focus();
}

// One colored icon per tray state (see tray-state.js); falls back to the plain icon.
let trayImages = null;
function trayImage(key) {
  if (!trayImages) {
    const plain = nativeImage.createFromPath(iconPath('tray.png'));
    trayImages = {};
    for (const k of TRAY_STATES) {
      const img = nativeImage.createFromPath(iconPath(`tray-${k}.png`));
      trayImages[k] = img.isEmpty() ? plain : img;
    }
  }
  return trayImages[key] || nativeImage.createEmpty();
}

function currentTrayState() {
  // While syncing, skip the disk reads: progress updates arrive several times a second.
  if (ctx.sync.busy) return trayState({ busy: true, phase: ctx.sync.status.phase });
  const s = ctx.store.settings();
  return trayState({
    busy: false,
    wizardComplete: !!s.wizardComplete,
    signedIn: ctx.auth.signedIn,
    database: readPointer(s.dataDir || defaultDataDir()),
    lastSync: ctx.store.history()[0],
    pendingReview: ctx.store.syncState()?.phase === 'rejected',
  });
}

let lastTrayKey = null;
function refreshTray() {
  if (!tray || tray.isDestroyed()) return;
  const st = currentTrayState();
  const wizardComplete = !!ctx.store.settings().wizardComplete;
  // Only touch the icon and menu when something visible changed.
  const key = `${st.key}|${st.label}|${wizardComplete}`;
  if (key === lastTrayKey) return;
  lastTrayKey = key;
  const busy = st.key === 'syncing';
  tray.setImage(trayImage(st.key));
  tray.setToolTip(`Forma Data Manager\n${st.label}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: st.label, icon: trayImage(st.key).resize({ width: 16, height: 16 }), click: showWindow },
      { type: 'separator' },
      { label: 'Open Forma Data Manager', click: showWindow },
      { label: busy ? 'Sync in progress…' : 'Sync now', enabled: !busy && wizardComplete, click: () => startSync('manual').catch(() => {}) },
      { type: 'separator' },
      { label: 'Open data folder', click: () => shell.openPath(ctx.store.settings().dataDir || defaultDataDir()) },
      { label: 'Open log folder', click: () => shell.openPath(ctx.log.dir) },
      { type: 'separator' },
      { label: 'Quit', click: () => ((quitting = true), app.quit()) },
    ])
  );
}

function createTray() {
  tray = new Tray(trayImage('notready'));
  tray.setToolTip('Forma Data Manager');
  refreshTray();
  // Data ages into "stale" and sign-ins can expire without any event, so re-check every minute.
  setInterval(refreshTray, 60_000);
  tray.on('click', showWindow);
}

const SAFE_URL = /^https:\/\/([a-z0-9-]+\.)*(autodesk\.com|claude\.ai|anthropic\.com|github\.com)(\/|$)/i;
function openSafe(url) {
  if (SAFE_URL.test(String(url))) shell.openExternal(url);
}

function startSync(trigger) {
  return ctx.sync.start(trigger).catch((e) => {
    ctx.log.warn(`Sync not started: ${e.message}`);
    throw e;
  });
}

function applyLoginItem() {
  const s = ctx.store.settings();
  if (process.platform !== 'win32' || !app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: !!(s.startAtLogin && s.wizardComplete), args: ['--hidden'], name: LOGIN_ITEM_NAME });
}

function readPointer(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'current.json'), 'utf8'));
  } catch {
    return null;
  }
}

function folderInfo(dir) {
  const info = { dir, exists: false, writable: false, freeGb: null, warnings: [] };
  try {
    fs.mkdirSync(dir, { recursive: true });
    info.exists = true;
    const probe = path.join(dir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    info.writable = true;
  } catch (e) {
    info.error = e.message;
  }
  try {
    const st = fs.statfsSync(dir);
    info.freeGb = Math.round(((st.bavail * st.bsize) / 1024 ** 3) * 10) / 10;
    if (info.freeGb < 6) info.warnings.push(`Only ${info.freeGb} GB free. Each sync needs room for the download plus two database versions (often 2–5 GB for a large hub).`);
  } catch {}
  if (/onedrive|dropbox|google drive|icloud/i.test(dir)) info.warnings.push('This folder looks cloud-synced. A new multi-GB database is written every day, which will churn your sync client. A local folder is better.');
  return info;
}

function publicState() {
  const s = ctx.store.settings();
  const dataDir = s.dataDir || defaultDataDir();
  const exe = ctx.engine.exePath;
  return {
    version: app.getVersion(),
    repoUrl: REPO_URL,
    settings: { ...s, dataDir: s.dataDir, defaultDataDir: defaultDataDir() },
    redirectUri: redirectUri(s.callbackPort),
    signedIn: ctx.auth.signedIn,
    user: ctx.auth.user,
    sync: ctx.sync.status,
    busy: ctx.sync.busy,
    pendingRejected: ctx.store.syncState()?.phase === 'rejected' ? ctx.store.syncState().message : null,
    history: ctx.store.history().slice(0, 20),
    database: readPointer(dataDir),
    nextRun: ctx.scheduler.nextRun()?.toISOString() ?? null,
    jobsLast24h: ctx.sync.jobsLast24h(),
    engineExe: exe,
    claude: exe ? claudeConfig.inspect(exe, dataDir) : [],
    claudeCodeCommand: exe ? claudeConfig.claudeCodeCommand(exe, dataDir) : null,
    logFile: ctx.log.file,
  };
}

// Called on every sync update and after any action that changes what the app shows.
// The tray updates right away (cheap, keyed); the window push is throttled because
// download/build progress can fire several times a second.
let pushTimer = null;
let lastPush = 0;
function pushState() {
  refreshTray();
  const send = () => {
    pushTimer = null;
    lastPush = Date.now();
    if (win && !win.isDestroyed()) win.webContents.send('state', publicState());
  };
  const wait = 400 - (Date.now() - lastPush);
  if (wait <= 0 && !pushTimer) send();
  else if (!pushTimer) pushTimer = setTimeout(send, Math.max(wait, 0));
}

function registerIpc() {
  const handle = (ch, fn) =>
    ipcMain.handle(ch, async (_e, ...args) => {
      try {
        return { ok: true, value: await fn(...args) };
      } catch (e) {
        ctx.log.warn(`${ch}: ${e.message}`);
        return { ok: false, error: e.message };
      }
    });

  handle('state:get', () => publicState());

  handle('settings:update', (patch) => {
    const allowed = ['clientId', 'callbackPort', 'schedule', 'startAtLogin', 'keepVersions', 'keepDownloads'];
    const clean = {};
    for (const k of allowed) if (k in patch) clean[k] = patch[k];
    if ('clientId' in clean) clean.clientId = String(clean.clientId).trim();
    if ('callbackPort' in clean) {
      const p = Number(clean.callbackPort);
      if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error('Callback port must be between 1024 and 65535.');
      clean.callbackPort = p;
    }
    if ('keepVersions' in clean) clean.keepVersions = Math.max(1, Math.min(5, Number(clean.keepVersions) || 2));
    if (clean.schedule) {
      if (!/^\d{1,2}:\d{2}$/.test(clean.schedule.time || '06:00')) throw new Error('Use a time like 06:00.');
      clean.schedule = { enabled: !!clean.schedule.enabled, time: clean.schedule.time || '06:00' };
    }
    ctx.store.updateSettings(clean);
    applyLoginItem();
    pushState();
    return publicState();
  });

  handle('disclaimer:accept', () => {
    ctx.store.updateSettings({ disclaimerAcceptedAt: new Date().toISOString() });
    return publicState();
  });

  handle('auth:signIn', async () => {
    const user = await ctx.auth.signIn();
    showWindow();
    pushState();
    return user;
  });
  handle('auth:signOut', () => {
    ctx.auth.signOut();
    pushState();
  });

  handle('hubs:list', () => ctx.aps.listHubs());
  handle('hub:select', (hub) => {
    if (!hub?.accountId) throw new Error('Pick a hub.');
    ctx.store.updateSettings({ hub: { id: hub.id, accountId: hub.accountId, name: hub.name, region: hub.region } });
    pushState();
    return publicState();
  });
  handle('hub:manual', (accountId, name) => {
    const id = String(accountId || '').trim().replace(/^b\./, '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('A hub (account) ID looks like 8-4-4-4-12 hex characters.');
    ctx.store.updateSettings({ hub: { id: `b.${id}`, accountId: id, name: String(name || '').trim() || id, region: null } });
    pushState();
    return publicState();
  });

  handle('dataDir:pick', async () => {
    const s = ctx.store.settings();
    const r = await dialog.showOpenDialog(win, { title: 'Choose the database folder', defaultPath: s.dataDir || defaultDataDir(), properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dataDir:check', (dir) => folderInfo(dir || defaultDataDir()));
  handle('dataDir:set', (dir) => {
    const info = folderInfo(dir);
    if (!info.writable) throw new Error(`Can't write to ${dir}: ${info.error || 'permission denied'}`);
    ctx.store.updateSettings({ dataDir: path.resolve(dir) });
    pushState();
    return info;
  });

  handle('sync:start', () => {
    if (ctx.sync.busy) throw new Error('A sync is already running.');
    const problem = ctx.sync.preflight();
    if (problem) throw new Error(problem);
    startSync('manual').catch(() => {}); // later failures are reported through sync status + history
    return publicState();
  });
  handle('sync:cancel', () => ctx.sync.cancel());
  handle('sync:useRejected', () => {
    ctx.sync.useRejectedAnyway().catch(() => {});
  });
  handle('sync:discardRejected', () => {
    ctx.sync.discardRejected();
    pushState();
  });
  handle('db:rollback', async () => {
    const r = await ctx.engine.rollback(ctx.store.settings().dataDir);
    ctx.log.info(`Rolled back to ${r.now_live}`);
    pushState();
    return r;
  });

  handle('claude:install', () => {
    const s = ctx.store.settings();
    const res = claudeConfig.install(ctx.engine.exePath, s.dataDir || defaultDataDir());
    ctx.log.info(`Claude Desktop config updated: ${JSON.stringify(res.map((r) => ({ file: r.file, ok: r.ok })))}`);
    pushState();
    return res;
  });
  handle('claude:uninstall', () => {
    const res = claudeConfig.uninstall();
    pushState();
    return res;
  });

  handle('skill:get', () => skill.readSkill(ctx.skillDir));
  handle('skill:saveZip', async (md) => {
    if (md) {
      const problem = skill.validateSkillMd(md);
      if (problem) throw new Error(problem);
    }
    const out = skill.writeSkillZip(ctx.skillDir, app.getPath('downloads'), { skillMd: md || undefined });
    shell.showItemInFolder(out);
    return out;
  });
  handle('skill:installClaudeCode', (md) => {
    if (md) {
      const problem = skill.validateSkillMd(md);
      if (problem) throw new Error(problem);
    }
    return skill.installForClaudeCode(ctx.skillDir, { skillMd: md || undefined });
  });

  handle('wizard:complete', () => {
    ctx.store.updateSettings({ wizardComplete: true });
    applyLoginItem();
    pushState();
    return publicState();
  });

  handle('open:url', (url) => openSafe(url));
  handle('open:path', (which) => {
    const s = ctx.store.settings();
    const target = { data: s.dataDir || defaultDataDir(), logs: ctx.log.dir }[which];
    if (target) shell.openPath(target);
  });
  handle('clipboard:write', (t) => require('electron').clipboard.writeText(String(t)));
}

app.whenReady().then(() => {
  ctx = makeContext();
  registerIpc();
  createWindow();
  createTray();
  ctx.sync.on('update', () => pushState());
  ctx.sync.resume();
  ctx.scheduler.start();
  powerMonitor.on('resume', () => setTimeout(() => ctx.scheduler.check(), 30_000));
  applyLoginItem();
});

app.on('second-instance', showWindow);
app.on('before-quit', () => {
  quitting = true;
});
app.on('window-all-closed', () => {
  /* keep running in the tray */
});
