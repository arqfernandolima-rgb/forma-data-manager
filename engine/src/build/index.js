/**
 * Build pipeline: Data Connector extract (ZIP or folder) -> new immutable SQLite file -> pointer swap.
 *
 * Steps
 *   1. Read the official schema (schemas/schema.json) shipped in the extract.
 *   2. Stream every CSV into a STRICT table, typing values from the schema.
 *   3. Indexes, defensive views, full-text search, project rollup, column stats.
 *   4. Integrity + sanity checks. Only then is the file promoted and current.json updated.
 * A failed or suspicious build never replaces the live database.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { openSource } from './source.js';
import { loadSchema } from './schema.js';
import { loadCsv } from './load.js';
import { safeIdentifier } from './normalize.js';
import { makeContext } from './views.js';
import { buildIndexes, buildViews, buildFts, buildProjectRollup, buildSummaries, buildViewStats } from './derived.js';
import { readPointer, writePointer, listDatabases, utcStamp, DB_PREFIX } from '../paths.js';
import { ENGINE_VERSION, SCHEMA_VERSION } from '../version.js';

export class BuildRejectedError extends Error {}

export async function buildDatabase({ zipPath, csvDir, dataDir, keep = 2, force = false, onEvent = () => {} }) {
  const t0 = Date.now();
  fs.mkdirSync(dataDir, { recursive: true });
  const stamp = utcStamp();
  const dbName = `${DB_PREFIX}${stamp}.db`;
  const finalPath = path.join(dataDir, dbName);
  const partialPath = `${finalPath}.partial`;
  for (const p of [partialPath, finalPath]) if (fs.existsSync(p)) fs.unlinkSync(p);

  const source = await openSource({ zipPath, csvDir });
  let db;
  try {
    const schema = await loadSchema(source);
    const csvEntries = source
      .list()
      .filter((f) => /\.csv$/i.test(f.name) && !f.name.includes('/'))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!csvEntries.length) throw new BuildRejectedError('No CSV files found in the extract.');
    onEvent({ event: 'start', source: source.label, csv_files: csvEntries.length, schema_tables: schema.size });

    db = new Database(partialPath, { create: true });
    db.exec('PRAGMA page_size = 8192');
    db.exec('PRAGMA journal_mode = OFF');
    db.exec('PRAGMA synchronous = OFF');
    db.exec('PRAGMA temp_store = MEMORY');
    db.exec('PRAGMA cache_size = -262144');
    // No locking_mode=EXCLUSIVE: bun's close() keeps the connection alive while cached
    // statements exist, and an exclusive lock would then block readers of the finished file.

    // ── 1-2. Load tables ──
    const tables = [];
    let totalRows = 0;
    for (let i = 0; i < csvEntries.length; i++) {
      const entry = csvEntries[i];
      const tableName = safeIdentifier(entry.name.replace(/\.csv$/i, ''));
      const stats = await loadCsv(db, source, entry.name, tableName, schema.get(tableName));
      if (!stats) continue;
      tables.push(stats);
      totalRows += stats.rows;
      onEvent({ event: 'table', index: i + 1, total: csvEntries.length, table: tableName, rows: stats.rows });
    }

    // ── Extraction metadata (metadata.csv is part of every extract) ──
    let extraction = {};
    try {
      extraction = db.query('SELECT * FROM metadata LIMIT 1').get() ?? {};
    } catch {}
    const asOf = String(extraction.created_at || extraction.request_end_date || new Date().toISOString()).slice(0, 10);

    // ── 3. Derived structures ──
    onEvent({ event: 'phase', name: 'indexes' });
    const indexCount = buildIndexes(db, tables);
    const ctx = makeContext(db, asOf);
    onEvent({ event: 'phase', name: 'views' });
    const views = buildViews(db, ctx);
    onEvent({ event: 'phase', name: 'search' });
    const fts = buildFts(db, ctx);
    onEvent({ event: 'phase', name: 'summaries' });
    const rollup = buildProjectRollup(db, views);
    buildSummaries(db, tables, schema, asOf);
    buildViewStats(db, views);

    db.exec('DROP TABLE IF EXISTS _views');
    db.exec('CREATE TABLE _views (name TEXT PRIMARY KEY, module TEXT, status TEXT, rows INTEGER, error TEXT, description TEXT)');
    const insV = db.query('INSERT INTO _views VALUES (?,?,?,?,?,?)');
    for (const v of views) insV.run(v.name, v.module ?? null, v.status, v.rows ?? null, v.error ?? null, v.description);

    // ── 4. Checks ──
    const projects = tables.find((t) => t.table === 'admin_projects')?.rows ?? 0;
    if (!projects) throw new BuildRejectedError('admin_projects is missing or empty, so this does not look like a complete hub extract.');
    const prev = readPointer(dataDir);
    const warnings = [];
    if (prev?.total_rows && totalRows < prev.total_rows * 0.5) {
      const msg = `New extract has ${totalRows.toLocaleString()} rows, less than half of the current ${prev.total_rows.toLocaleString()}.`;
      if (!force) throw new BuildRejectedError(`${msg} Kept the current database. Re-run with --force to use it anyway.`);
      warnings.push(msg);
    }
    const failedViews = views.filter((v) => v.status === 'error');
    if (failedViews.length) warnings.push(`Views with errors: ${failedViews.map((v) => `${v.name} (${v.error})`).join('; ')}`);
    const anomalyCount = tables.reduce((s, t) => s + Object.values(t.anomalies).reduce((a, b) => a + b.count, 0), 0);
    const parseErrors = tables.reduce((s, t) => s + t.parseErrors, 0);

    onEvent({ event: 'phase', name: 'finalize' });
    db.exec('DROP TABLE IF EXISTS _meta');
    db.exec('CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT)');
    const meta = {
      engine_version: ENGINE_VERSION,
      schema_version: String(SCHEMA_VERSION),
      built_at: new Date().toISOString(),
      as_of: asOf,
      source: source.label,
      extraction_created_at: extraction.created_at ?? null,
      extraction_request_start: extraction.request_start_date ?? null,
      extraction_request_end: extraction.request_end_date ?? null,
      extraction_region: extraction.region ?? null,
      table_count: String(tables.length),
      total_rows: String(totalRows),
      index_count: String(indexCount),
      views_ok: String(views.filter((v) => v.status === 'ok').length),
      views_failed: JSON.stringify(failedViews.map((v) => ({ name: v.name, error: v.error }))),
      fts_tables: String(fts.length),
      project_rollup: rollup ? '1' : '0',
      value_anomalies: String(anomalyCount),
      parse_errors: String(parseErrors),
      warnings: JSON.stringify(warnings),
      build_complete: '1',
    };
    const insM = db.query('INSERT INTO _meta VALUES (?, ?)');
    for (const [k, v] of Object.entries(meta)) insM.run(k, v == null ? null : String(v));

    db.exec('PRAGMA analysis_limit = 1000');
    db.exec('ANALYZE');
    const check = db.query('PRAGMA quick_check').get();
    const checkVal = check && Object.values(check)[0];
    if (checkVal !== 'ok') throw new BuildRejectedError(`SQLite integrity check failed: ${checkVal}`);
    db.exec('PRAGMA journal_mode = DELETE');
    db.close();
    db = null;

    fs.renameSync(partialPath, finalPath);
    const sizeBytes = fs.statSync(finalPath).size;
    const pointer = {
      db: dbName,
      as_of: asOf,
      built_at: meta.built_at,
      extraction_created_at: meta.extraction_created_at,
      total_rows: totalRows,
      table_count: tables.length,
      size_bytes: sizeBytes,
      engine_version: ENGINE_VERSION,
      schema_version: SCHEMA_VERSION,
      warnings,
    };
    writePointer(dataDir, pointer);
    const removed = cleanupOldDatabases(dataDir, keep);

    const result = {
      event: 'done',
      db: finalPath,
      as_of: asOf,
      tables: tables.length,
      rows: totalRows,
      views_ok: Number(meta.views_ok),
      views_failed: failedViews.map((v) => v.name),
      indexes: indexCount,
      value_anomalies: anomalyCount,
      parse_errors: parseErrors,
      warnings,
      size_mb: Math.round(sizeBytes / 1048576),
      seconds: Math.round((Date.now() - t0) / 100) / 10,
      removed_old: removed,
      table_counts: Object.fromEntries(tables.map((t) => [t.table, t.rows])),
    };
    onEvent(result);
    return result;
  } catch (e) {
    try {
      db?.close();
    } catch {}
    try {
      if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath);
    } catch {}
    throw e;
  } finally {
    source.close();
  }
}

/** Keep the live database plus (keep - 1) previous ones. Files still open elsewhere are skipped and retried next time. */
export function cleanupOldDatabases(dataDir, keep = 2) {
  const live = readPointer(dataDir)?.db;
  const all = listDatabases(dataDir);
  const keepSet = new Set([live, ...all.filter((f) => f !== live).slice(0, Math.max(0, keep - 1))]);
  const removed = [];
  for (const f of all) {
    if (keepSet.has(f)) continue;
    try {
      fs.unlinkSync(path.join(dataDir, f));
      removed.push(f);
    } catch {
      /* still open by a server; try again after the next build */
    }
  }
  for (const f of fs.readdirSync(dataDir)) {
    if (f.endsWith('.db.partial')) {
      try {
        fs.unlinkSync(path.join(dataDir, f));
      } catch {}
    }
  }
  return removed;
}
