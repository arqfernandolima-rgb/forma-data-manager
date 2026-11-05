'use strict';
/**
 * Registers the MCP server with Claude Desktop by editing claude_desktop_config.json.
 *
 * Claude Desktop on Windows keeps its config in one of two places:
 *   Regular installer:  %APPDATA%\Claude\claude_desktop_config.json
 *   Store / MSIX:       %LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude\claude_desktop_config.json
 * We update every location whose Claude folder exists, always back up first,
 * merge into "mcpServers" (other servers and settings are untouched), and never
 * write over a file we can't parse.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SERVER_KEY = 'forma-data';
const LEGACY_KEYS = ['acc-data'];

function candidateConfigPaths(env = process.env) {
  const out = [];
  const appData = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  if (process.platform === 'darwin') {
    out.push({ kind: 'macos', dir: path.join(os.homedir(), 'Library', 'Application Support', 'Claude') });
  } else {
    out.push({ kind: 'installer', dir: path.join(appData, 'Claude') });
    try {
      const pkgs = path.join(localAppData, 'Packages');
      for (const d of fs.readdirSync(pkgs)) {
        if (/^Claude_/i.test(d)) out.push({ kind: 'store', dir: path.join(pkgs, d, 'LocalCache', 'Roaming', 'Claude') });
      }
    } catch {}
  }
  return out.map((c) => ({ ...c, file: path.join(c.dir, 'claude_desktop_config.json'), exists: fs.existsSync(c.dir) }));
}

function readConfig(file) {
  if (!fs.existsSync(file)) return { config: {}, existed: false };
  const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  if (!raw.trim()) return { config: {}, existed: true };
  return { config: JSON.parse(raw), existed: true };
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
}

function serverEntry(exePath, dataDir) {
  return { command: exePath, args: ['serve'], env: { FORMA_DATA_DIR: dataDir } };
}

/** Status for the UI: where Claude Desktop lives, and whether we're registered there. */
function inspect(exePath, dataDir) {
  return candidateConfigPaths().map((c) => {
    if (!c.exists) return { ...c, state: 'not-installed' };
    try {
      const { config } = readConfig(c.file);
      const entry = config?.mcpServers?.[SERVER_KEY];
      const legacy = LEGACY_KEYS.filter((k) => config?.mcpServers?.[k]);
      const want = serverEntry(exePath, dataDir);
      const current = entry && entry.command === want.command && entry.env?.FORMA_DATA_DIR === want.env.FORMA_DATA_DIR;
      return { ...c, state: entry ? (current ? 'configured' : 'outdated') : 'missing', legacy };
    } catch (e) {
      return { ...c, state: 'invalid-json', error: e.message };
    }
  });
}

/**
 * Add/refresh our entry in every Claude Desktop config found.
 * @returns {Array<{file, kind, ok, backup?, error?, removedLegacy?}>}
 */
function install(exePath, dataDir, { removeLegacy = true } = {}) {
  if (!exePath) throw new Error('Engine executable not found. Reinstall Forma Data Manager.');
  const results = [];
  const targets = candidateConfigPaths().filter((c) => c.exists);
  if (!targets.length) {
    throw new Error('Claude Desktop was not found for this Windows user. Install Claude Desktop (claude.ai/download), open it once, then try again.');
  }
  for (const t of targets) {
    try {
      const { config, existed } = readConfig(t.file);
      let backup = null;
      if (existed) {
        backup = `${t.file}.bak-${stamp()}`;
        fs.copyFileSync(t.file, backup);
      }
      config.mcpServers = config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : {};
      config.mcpServers[SERVER_KEY] = serverEntry(exePath, dataDir);
      const removedLegacy = [];
      if (removeLegacy) {
        for (const k of LEGACY_KEYS) {
          if (config.mcpServers[k]) {
            delete config.mcpServers[k];
            removedLegacy.push(k);
          }
        }
      }
      const tmp = `${t.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
      fs.renameSync(tmp, t.file);
      results.push({ file: t.file, kind: t.kind, ok: true, backup, removedLegacy });
    } catch (e) {
      results.push({ file: t.file, kind: t.kind, ok: false, error: e instanceof SyntaxError ? `Existing file is not valid JSON, left untouched: ${e.message}` : e.message });
    }
  }
  return results;
}

function uninstall() {
  const results = [];
  for (const t of candidateConfigPaths().filter((c) => c.exists && fs.existsSync(c.file))) {
    try {
      const { config } = readConfig(t.file);
      if (!config?.mcpServers?.[SERVER_KEY]) continue;
      fs.copyFileSync(t.file, `${t.file}.bak-${stamp()}`);
      delete config.mcpServers[SERVER_KEY];
      fs.writeFileSync(t.file, JSON.stringify(config, null, 2) + '\n');
      results.push({ file: t.file, ok: true });
    } catch (e) {
      results.push({ file: t.file, ok: false, error: e.message });
    }
  }
  return results;
}

/** Equivalent one-liner for Claude Code users. */
function claudeCodeCommand(exePath, dataDir) {
  return `claude mcp add ${SERVER_KEY} --scope user -e FORMA_DATA_DIR="${dataDir}" -- "${exePath}" serve`;
}

module.exports = { candidateConfigPaths, inspect, install, uninstall, claudeCodeCommand, serverEntry, SERVER_KEY };
