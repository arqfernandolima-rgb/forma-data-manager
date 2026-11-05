/**
 * Owns the live database for the MCP server:
 *  - follows <dataDir>/current.json and reopens when a new build is promoted (no restart needed)
 *  - main-thread read-only connection for small metadata queries
 *  - a worker thread for user SQL, with a timeout that abandons runaway queries
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from 'bun:sqlite';
import { readPointer, POINTER_FILE } from '../paths.js';
import { SCHEMA_VERSION } from '../version.js';

const POLL_MS = 3000;

export class Store {
  constructor(dataDir, log = () => {}) {
    this.dataDir = dataDir;
    this.log = log;
    this.db = null;
    this.dbFile = null;
    this.meta = {};
    this.pointer = null;
    this.error = null;
    this.lastPointerMtime = 0;
    this.worker = null;
    this.pending = new Map();
    this.seq = 0;
    this.cache = new Map();
  }

  start() {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), POLL_MS);
    this.timer.unref?.();
  }

  get ready() {
    return !!this.db;
  }

  refresh() {
    const pFile = path.join(this.dataDir, POINTER_FILE);
    let mtime = 0;
    try {
      mtime = fs.statSync(pFile).mtimeMs;
    } catch {
      if (!this.db) this.error = `No database yet in ${this.dataDir}. Run a sync from the Forma Data Manager app.`;
      return;
    }
    if (mtime === this.lastPointerMtime && this.db) return;
    const pointer = readPointer(this.dataDir);
    if (!pointer) return;
    this.lastPointerMtime = mtime;
    if (pointer.db === this.dbFile && this.db) {
      this.pointer = pointer;
      return;
    }
    const file = path.join(this.dataDir, pointer.db);
    try {
      const next = new Database(file, { readonly: true });
      next.exec('PRAGMA query_only = 1');
      next.exec('PRAGMA temp_store = MEMORY');
      next.exec('PRAGMA cache_size = -131072');
      next.exec('PRAGMA mmap_size = 2147483648');
      const meta = Object.fromEntries(next.query('SELECT key, value FROM _meta').all().map((r) => [r.key, r.value]));
      if (meta.build_complete !== '1') throw new Error('database build is incomplete');
      if (Number(meta.schema_version) !== SCHEMA_VERSION) {
        throw new Error(`database layout v${meta.schema_version} doesn't match this server (v${SCHEMA_VERSION}). Update the app or run a new sync.`);
      }
      const old = this.db;
      this.db = next;
      this.dbFile = pointer.db;
      this.dbPath = file;
      this.meta = meta;
      this.pointer = pointer;
      this.error = null;
      this.cache.clear();
      try {
        old?.close();
      } catch {}
      // Let the worker release the old file too (it reopens the new one on its next query),
      // so the previous version can be cleaned up on Windows.
      try {
        this.worker?.postMessage({ id: 0, type: 'close' });
      } catch {}
      this.log(`Loaded ${pointer.db} (data as of ${meta.as_of}, ${Number(meta.total_rows).toLocaleString()} rows)`);
    } catch (e) {
      this.error = `Could not open ${pointer.db}: ${e.message}`;
      this.log(this.error);
    }
  }

  /** Small cached metadata lookups (cleared on reload). */
  memo(key, fn) {
    if (!this.cache.has(key)) this.cache.set(key, fn());
    return this.cache.get(key);
  }

  all(sql, ...params) {
    return this.db.query(sql).all(...params);
  }

  get(sql, ...params) {
    return this.db.query(sql).get(...params);
  }

  objects() {
    return this.memo('objects', () => {
      const rows = this.all(`SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'`);
      return new Map(rows.map((r) => [r.name, r.type]));
    });
  }

  columnsOf(name) {
    return this.memo(`cols:${name}`, () => {
      try {
        return this.all(`PRAGMA table_info("${name.replace(/"/g, '""')}")`).map((r) => r.name);
      } catch {
        return [];
      }
    });
  }

  // ── Worker-backed SQL ──

  /** Worker location differs between `bun src/cli.js` and the compiled exe (bundle root). */
  workerUrl() {
    for (const rel of ['./query-worker.js', './server/query-worker.js']) {
      const u = new URL(rel, import.meta.url);
      try {
        if (fs.existsSync(fileURLToPath(u))) return u.href;
      } catch {}
    }
    return null;
  }

  /** Resolves to a ready worker, or null (then queries run inline, without a timeout). */
  ensureWorker() {
    if (this.workerFailed) return Promise.resolve(null);
    if (this.workerReady) return this.workerReady;
    this.workerReady = new Promise((resolve) => {
      const href = this.workerUrl();
      if (!href) return this.failWorker('worker file not found', resolve);
      let w;
      try {
        w = new Worker(href);
      } catch (e) {
        return this.failWorker(e.message, resolve);
      }
      const startTimer = setTimeout(() => this.failWorker('worker did not start', resolve), 5000);
      w.onmessage = (e) => {
        if (e.data?.type === 'ready') {
          clearTimeout(startTimer);
          this.worker = w;
          resolve(w);
          return;
        }
        const p = this.pending.get(e.data?.id);
        if (!p) return;
        this.pending.delete(e.data.id);
        clearTimeout(p.timer);
        p.resolve(e.data);
      };
      w.onerror = (e) => {
        clearTimeout(startTimer);
        if (!this.worker) this.failWorker(e.message, resolve);
        else this.log(`Query worker error: ${e.message}`);
      };
    });
    return this.workerReady;
  }

  failWorker(reason, resolve) {
    this.workerFailed = true;
    this.log(`Query worker unavailable (${reason}); running queries inline without a timeout.`);
    resolve(null);
  }

  async runQuery(sql, { maxRows = 200, timeoutMs = 30000 } = {}) {
    const w = await this.ensureWorker();
    if (!w) return this.runInline(sql, maxRows);
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Abandon the stuck worker; a fresh one serves the next call.
        try {
          this.worker.terminate();
        } catch {}
        this.worker = null;
        this.workerReady = null;
        for (const [pid, p] of this.pending) {
          clearTimeout(p.timer);
          p.resolve({ ok: false, error: 'Query cancelled because another query timed out. Run it again.' });
          this.pending.delete(pid);
        }
        resolve({ ok: false, error: `Query took longer than ${Math.round(timeoutMs / 1000)}s and was stopped. Aggregate (GROUP BY), filter by project, or avoid joining two large tables directly.`, timeout: true });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      w.postMessage({ id, path: this.dbPath, sql, maxRows });
    });
  }

  runInline(sql, maxRows) {
    let stmt;
    try {
      const t0 = performance.now();
      stmt = this.db.prepare(sql);
      const columns = stmt.columnNames;
      const rows = [];
      let truncated = false;
      for (const row of stmt.iterate()) {
        if (rows.length >= maxRows) {
          truncated = true;
          break;
        }
        rows.push(columns.map((c) => row[c]));
      }
      return { ok: true, columns, rows, truncated, ms: Math.round(performance.now() - t0) };
    } catch (e) {
      return { ok: false, error: e.message };
    } finally {
      try {
        stmt?.finalize();
      } catch {}
    }
  }
}
