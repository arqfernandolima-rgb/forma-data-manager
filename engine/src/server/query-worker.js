/**
 * Runs user SQL off the main thread, so a slow query can be abandoned (timeout)
 * without freezing the MCP server. Holds its own read-only connection.
 */
import { Database } from 'bun:sqlite';

let db = null;
let dbPath = null;

function open(path) {
  if (db && dbPath === path) return;
  try {
    db?.close();
  } catch {}
  db = new Database(path, { readonly: true });
  db.exec('PRAGMA query_only = 1');
  db.exec('PRAGMA temp_store = MEMORY');
  db.exec('PRAGMA cache_size = -131072');
  db.exec('PRAGMA mmap_size = 2147483648');
  dbPath = path;
}

postMessage({ type: 'ready' });

self.onmessage = (e) => {
  const { id, type, path, sql, maxRows } = e.data || {};
  try {
    if (type === 'close') {
      try {
        db?.close();
      } catch {}
      db = null;
      dbPath = null;
      postMessage({ id, ok: true });
      return;
    }
    open(path);
    const t0 = performance.now();
    // prepare() (not query()) so statements aren't cached: an early-stopped iterator must not leak into the next call.
    let stmt = db.prepare(sql);
    // Columns can repeat in a SELECT (e.g. a.id, b.id) and object rows would collapse them.
    // Wrapping in a subquery makes SQLite give the duplicates distinct names (id, id:1).
    if (new Set(stmt.columnNames).size !== stmt.columnNames.length) {
      stmt.finalize();
      stmt = db.prepare(`SELECT * FROM (${sql})`);
    }
    const columns = stmt.columnNames;
    const rows = [];
    let truncated = false;
    // iterate() is lazy: we stop reading as soon as we have enough rows.
    for (const row of stmt.iterate()) {
      if (rows.length >= maxRows) {
        truncated = true;
        break;
      }
      rows.push(columns.map((c) => row[c]));
    }
    stmt.finalize();
    postMessage({ id, ok: true, columns, rows, truncated, ms: Math.round(performance.now() - t0) });
  } catch (err) {
    postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
