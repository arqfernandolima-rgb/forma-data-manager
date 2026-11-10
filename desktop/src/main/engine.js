'use strict';
/**
 * Runs the bundled engine (forma-data.exe) for builds, info and rollback.
 * Packaged app: <resources>/engine/forma-data.exe. Development: `bun ../engine/src/cli.js`.
 */
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { WALL_CLOCK } = require('./power');

const BUILD_LIMIT_MS = 2 * 60 * 60_000; // a build takes minutes; this only stops a stuck one
const fmtHours = (ms) => `${Math.round((ms / 3_600_000) * 10) / 10} hours`;

function engineCommand({ isPackaged, resourcesPath, appRoot }) {
  if (isPackaged) {
    const exe = path.join(resourcesPath, 'engine', process.platform === 'win32' ? 'forma-data.exe' : 'forma-data');
    return { command: exe, prefix: [], exePath: exe };
  }
  const local = path.join(appRoot, '..', 'engine', 'dist', process.platform === 'win32' ? 'forma-data.exe' : 'forma-data');
  if (fs.existsSync(local)) return { command: local, prefix: [], exePath: local };
  return { command: process.env.BUN_PATH || 'bun', prefix: [path.join(appRoot, '..', 'engine', 'src', 'cli.js')], exePath: null };
}

class Engine {
  constructor(cmd, log, { sleep = WALL_CLOCK, now = () => Date.now(), watchMs = 30_000 } = {}) {
    this.cmd = cmd;
    this.log = log;
    this.current = null;
    this.sleepTracker = sleep; // so time the PC spends asleep doesn't count against the limit
    this.now = now;
    this.watchMs = watchMs;
  }

  get exePath() {
    return this.cmd.exePath;
  }

  run(args, { onEvent, timeoutMs = BUILD_LIMIT_MS } = {}) {
    return new Promise((resolve, reject) => {
      const child = cp.spawn(this.cmd.command, [...this.cmd.prefix, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.current = child;
      let buf = '';
      let stderr = '';
      let last = null;
      // Count only time the PC is awake: a build paused by sleep (it was at 4:25 AM on Nov 8, 2026)
      // must not be killed the moment the PC wakes because the wall clock passed the limit.
      const started = this.now();
      let timedOut = false;
      let stopped = false;
      const timer = setInterval(() => {
        if (this.sleepTracker.awakeBetween(started, this.now()) > timeoutMs) {
          timedOut = true;
          child.kill();
        }
      }, this.watchMs);
      timer.unref?.();
      child.stopByUser = () => {
        stopped = true;
        child.kill();
      };
      child.stdout.on('data', (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          try {
            const ev = JSON.parse(line);
            last = ev;
            onEvent?.(ev);
          } catch {
            last = { raw: line };
          }
        }
      });
      child.stderr.on('data', (d) => {
        stderr += d.toString();
        if (stderr.length > 20000) stderr = stderr.slice(-20000);
      });
      child.on('error', (e) => {
        clearInterval(timer);
        this.current = null;
        reject(new Error(`Could not start the engine (${this.cmd.command}): ${e.message}`));
      });
      child.on('exit', (code, signal) => {
        clearInterval(timer);
        this.current = null;
        if (code === 0) resolve(last);
        else {
          let fallback = `The database build stopped with exit code ${code}.`;
          if (timedOut) fallback = `The database build was still running after ${fmtHours(timeoutMs)} (not counting time the PC was asleep), so it was stopped. The previous data is still in use.`;
          else if (stopped) fallback = 'The database build was stopped.';
          else if (code === null) fallback = `The database build was stopped before it finished${signal ? ` (${signal})` : ''}. The previous data is still in use.`;
          const err = new Error(timedOut ? fallback : last?.event === 'error' ? last.message : stderr.trim().split('\n').slice(-3).join(' ') || fallback);
          err.timedOut = timedOut;
          err.rejected = !!last?.rejected;
          reject(err);
        }
      });
    });
  }

  build({ zipPath, csvDir, dataDir, keep, force, onEvent }) {
    const args = ['build', '--json', '--data-dir', dataDir, '--keep', String(keep || 2)];
    if (zipPath) args.push('--zip', zipPath);
    if (csvDir) args.push('--csv-dir', csvDir);
    if (force) args.push('--force');
    return this.run(args, { onEvent });
  }

  async info(dataDir) {
    const out = await this.runCapture(['info', '--data-dir', dataDir]);
    return JSON.parse(out);
  }

  async rollback(dataDir) {
    return JSON.parse(await this.runCapture(['rollback', '--data-dir', dataDir]));
  }

  runCapture(args) {
    return new Promise((resolve, reject) => {
      cp.execFile(this.cmd.command, [...this.cmd.prefix, ...args], { windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr?.trim() || err.message));
        else resolve(stdout);
      });
    });
  }

  cancel() {
    try {
      if (this.current?.stopByUser) this.current.stopByUser();
      else this.current?.kill();
    } catch {}
  }
}

module.exports = { Engine, engineCommand };
