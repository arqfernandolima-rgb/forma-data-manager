/**
 * Data folder layout (one folder, chosen in the desktop app's setup wizard):
 *
 *   <dataDir>/current.json            pointer: which database file is live
 *   <dataDir>/forma-<UTC stamp>.db     immutable database versions (newest + previous kept)
 *   <dataDir>/downloads/               temporary extract downloads (deleted after a build)
 *   <dataDir>/logs/                    sync and build logs (written by the desktop app)
 *
 * Why a pointer file instead of renaming the database: on Windows you can't
 * rename or replace a file another process has open, and Claude Desktop and
 * Claude Code may each run their own server. Every build writes a new file, then
 * atomically replaces the tiny pointer. Servers notice and reopen. Old files are
 * removed later, once nothing has them open.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const POINTER_FILE = 'current.json';
export const DB_PREFIX = 'forma-';

export function defaultDataDir() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'FormaData');
  }
  return path.join(os.homedir(), '.forma-data');
}

export function resolveDataDir(explicit) {
  return path.resolve(explicit || process.env.FORMA_DATA_DIR || defaultDataDir());
}

export function readPointer(dataDir) {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(dataDir, POINTER_FILE), 'utf8'));
    if (p && typeof p.db === 'string') return p;
  } catch {}
  return null;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Atomically replace current.json. Retries briefly if a reader has it open (Windows). */
export function writePointer(dataDir, pointer) {
  const target = path.join(dataDir, POINTER_FILE);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(pointer, null, 2));
  let lastErr;
  for (let i = 0; i < 20; i++) {
    try {
      fs.renameSync(tmp, target);
      return;
    } catch (e) {
      lastErr = e;
      sleepSync(100 * (i + 1));
    }
  }
  try {
    fs.unlinkSync(tmp);
  } catch {}
  throw lastErr;
}

export function listDatabases(dataDir) {
  try {
    return fs
      .readdirSync(dataDir)
      .filter((f) => f.startsWith(DB_PREFIX) && f.endsWith('.db'))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

export function utcStamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
}
