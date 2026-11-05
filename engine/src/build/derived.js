/**
 * Everything computed after the raw tables are loaded:
 * indexes, full-text search, lookup-safe views, precomputed summaries and column stats.
 */
import { VIEW_DEFS, VIEW_MODULE } from './views.js';
import { moduleOf } from '../modules.js';

const q = (id) => `"${String(id).replace(/"/g, '""')}"`;

// ─── Indexes ────────────────────────────────────────────────────────────────

const INDEX_COLS = /^(id|bim360_project_id|autodesk_id|status|status_value|state|created_at|updated_at|due_date|deleted_at|name|form_type|chain_key)$|_id$/;
const SKIP_INDEX = new Set(['bim360_account_id']);

export function buildIndexes(db, tables) {
  let count = 0;
  for (const t of tables) {
    if (t.rows < 50) continue;
    const names = t.columns.map((c) => c.name);
    for (const col of names) {
      if (SKIP_INDEX.has(col) || !INDEX_COLS.test(col)) continue;
      db.exec(`CREATE INDEX IF NOT EXISTS ${q(`ix_${t.table}__${col}`)} ON ${q(t.table)} (${q(col)})`);
      count++;
    }
    if (t.rows >= 200 && names.includes('bim360_project_id')) {
      for (const second of ['status', 'status_value', 'deleted_at', 'due_date', 'created_at']) {
        if (!names.includes(second)) continue;
        db.exec(`CREATE INDEX IF NOT EXISTS ${q(`ix_${t.table}__proj_${second}`)} ON ${q(t.table)} (bim360_project_id, ${q(second)})`);
        count++;
      }
    }
  }
  return count;
}

// ─── Full-text search ───────────────────────────────────────────────────────

// Text columns worth searching, per table. Missing tables/columns are skipped.
const FTS_CONFIG = [
  ['issues_issues', ['title', 'description', 'response', 'location_details'], 'title', 'status'],
  ['issuesbim360_issues', ['title', 'description', 'response', 'location_details'], 'title', 'status'],
  ['issues_comments', ['comment_body', 'body'], null, null],
  ['rfis_rfis', ['title', 'question', 'official_response', 'suggested_answer'], 'title', 'status'],
  ['rfis_comments', ['body'], null, null],
  ['submittalsacc_items', ['title', 'description', 'response_comment'], 'title', 'status_value'],
  ['submittals_items', ['title', 'description', 'response_comment'], 'title', 'status_value'],
  ['meetingminutes_meetings', ['title', 'description', 'summary'], 'title', 'status'],
  ['meetingminutes_items', ['description'], 'description', 'status'],
  ['meetingminutes_topics', ['name'], 'name', null],
  ['checklists_checklists', ['title', 'instructions'], 'title', 'status'],
  ['checklists_checklist_items', ['title', 'note'], 'title', null],
  ['dailylogs_notes', ['title', 'content'], 'title', null],
  ['forms_forms', ['name', 'description', 'notes'], 'name', 'status'],
  ['assets_assets', ['client_asset_id', 'description', 'barcode'], 'client_asset_id', null],
  ['cost_change_orders', ['name', 'description', 'scope_of_work', 'note'], 'name', 'cost_status'],
  ['cost_contracts', ['name', 'description', 'scope_of_work', 'note'], 'name', 'status'],
  ['cost_budgets', ['code', 'name', 'description'], 'name', null],
  ['schedule_activities', ['name', 'wbs_path_text'], 'name', null],
  ['photos_photos', ['title', 'description'], 'title', 'status'],
  ['admin_companies', ['name', 'trade', 'description'], 'name', 'status'],
  ['admin_projects', ['name', 'job_number', 'city'], 'name', 'status'],
];

export function buildFts(db, ctx) {
  db.exec('DROP TABLE IF EXISTS _fts');
  db.exec(`CREATE VIRTUAL TABLE _fts USING fts5(
    source_table UNINDEXED, source_rowid UNINDEXED, bim360_project_id UNINDEXED,
    title UNINDEXED, status UNINDEXED, content,
    tokenize = 'unicode61 remove_diacritics 2'
  )`);
  const ins = db.query('INSERT INTO _fts VALUES (?, ?, ?, ?, ?, ?)');
  const many = db.transaction((rows) => {
    for (const r of rows) ins.run(...r);
  });
  const indexed = [];
  for (const [table, cols, titleCol, statusCol] of FTS_CONFIG) {
    if (!ctx.has(table)) continue;
    const valid = cols.filter((c) => ctx.has(table, c));
    if (!valid.length) continue;
    const proj = ctx.has(table, 'bim360_project_id') ? 'bim360_project_id' : table === 'admin_projects' ? 'id' : null;
    const title = titleCol && ctx.has(table, titleCol) ? q(titleCol) : 'NULL';
    const status = statusCol && ctx.has(table, statusCol) ? q(statusCol) : 'NULL';
    const where = ctx.has(table, 'deleted_at') ? 'WHERE deleted_at IS NULL' : '';
    // concat_ws skips NULLs, so excerpts don't fill up with empty " |  | " separators.
    const text = `concat_ws(' | ', ${valid.map((c) => `NULLIF(trim(${q(c)}), '')`).join(', ')})`;
    const rows = db
      .query(`SELECT rowid AS rid, ${proj ? q(proj) : 'NULL'} AS pid, ${title} AS title, ${status} AS status, ${text} AS content FROM ${q(table)} ${where}`)
      .all()
      .filter((r) => r.content)
      .map((r) => [table, r.rid, r.pid, r.title == null ? null : String(r.title).slice(0, 200), r.status, r.content]);
    if (rows.length) {
      many(rows);
      indexed.push({ table, rows: rows.length });
    }
  }
  db.exec(`INSERT INTO _fts(_fts) VALUES('optimize')`);
  return indexed;
}

// ─── Views ──────────────────────────────────────────────────────────────────

export function buildViews(db, ctx, viewDefs = VIEW_DEFS) {
  const built = new Set();
  const results = [];
  for (const def of viewDefs) {
    let sql = null;
    try {
      sql = def.build(ctx, built);
    } catch (e) {
      results.push({ name: def.name, status: 'error', error: e.message, description: def.description });
      continue;
    }
    if (!sql) {
      results.push({ name: def.name, status: 'skipped', error: 'source table not in this extract', description: def.description });
      continue;
    }
    try {
      db.exec(`DROP VIEW IF EXISTS ${q(def.name)}`);
      db.exec(`CREATE VIEW ${q(def.name)} AS\n${sql}`);
      // Compile + run once so a broken view fails here, not in front of a user.
      const n = db.query(`SELECT COUNT(*) AS n FROM ${q(def.name)}`).get().n;
      built.add(def.name);
      results.push({ name: def.name, status: 'ok', rows: n, description: def.description, module: VIEW_MODULE[def.name] ?? null });
    } catch (e) {
      try {
        db.exec(`DROP VIEW IF EXISTS ${q(def.name)}`);
      } catch {}
      results.push({ name: def.name, status: 'error', error: e.message, description: def.description });
    }
  }
  return results;
}

// ─── Project rollup (precomputed, one row per project) ──────────────────────

export function buildProjectRollup(db, views) {
  const ok = new Set(views.filter((v) => v.status === 'ok').map((v) => v.name));
  if (!ok.has('v_projects')) return false;

  const parts = [];
  const add = (alias, viewName, selectSql) => {
    if (ok.has(viewName)) parts.push({ alias, sql: `${alias} AS (SELECT bim360_project_id AS pid, ${selectSql} FROM ${viewName} GROUP BY bim360_project_id)` });
  };
  add('iss', 'v_all_issues', `SUM(status_group = 'open') AS issues_open, SUM(is_overdue) AS issues_overdue, COUNT(*) AS issues_total`);
  add('rfi', 'v_rfis', `SUM(status_group = 'open') AS rfis_open, SUM(is_overdue) AS rfis_overdue, COUNT(*) AS rfis_total, SUM(status_group = 'open' AND lower(COALESCE(cost_impact, '')) IN ('yes', 'true', '1')) AS rfis_open_cost_impact`);
  add('sub', 'v_submittals', `SUM(status_group = 'open') AS submittals_open, SUM(is_overdue) AS submittals_overdue, COUNT(*) AS submittals_total`);
  add('chk', 'v_checklists', `SUM(status_group = 'open') AS checklists_open, COUNT(*) AS checklists_total`);
  add('mtg', 'v_meeting_items', `SUM(status_group = 'open') AS meeting_items_open, SUM(is_overdue) AS meeting_items_overdue, SUM(status_group = 'open' AND due_date IS NULL) AS meeting_items_open_no_due_date`);
  add('frm', 'v_forms', `SUM(status_group = 'open') AS forms_open, COUNT(*) AS forms_total`);
  add('ast', 'v_assets', `COUNT(*) AS assets_total`);
  add('bud', 'v_cost_budgets', `SUM(CASE WHEN has_children = 0 THEN original_amount END) AS budget_original, SUM(CASE WHEN has_children = 0 THEN revised END) AS budget_revised, SUM(CASE WHEN has_children = 0 THEN forecast_final_cost END) AS forecast_final_cost, SUM(CASE WHEN has_children = 0 THEN forecast_variance END) AS forecast_variance, SUM(CASE WHEN has_children = 0 THEN actual_cost END) AS actual_cost`);
  add('coc', 'v_change_order_chains', `SUM(open_legs > 0) AS change_orders_open, SUM(CASE WHEN open_legs > 0 THEN exposure END) AS change_order_open_exposure, COUNT(*) AS change_orders_total`);
  add('sch', 'v_schedule_activities', `SUM(is_late) AS schedule_late_activities, COUNT(*) AS schedule_activities_total`);

  const ctes = parts.map((p) => p.sql).join(',\n');
  const joins = parts.map((p) => `LEFT JOIN ${p.alias} ON ${p.alias}.pid = p.project_id`).join('\n');
  const cols = parts.map((p) => `${p.alias}.*`).join(', ');
  db.exec('DROP TABLE IF EXISTS project_rollup');
  db.exec(`CREATE TABLE project_rollup AS
WITH ${ctes}
SELECT p.project_id, p.project_name, p.status, p.project_type, p.classification, p.is_production, p.looks_like_test${cols ? ', ' + cols : ''}
FROM v_projects p
${joins}`);
  // Drop the helper pid columns that came along with alias.*
  const pidCols = db.query(`PRAGMA table_info(project_rollup)`).all().map((r) => r.name).filter((n) => /^pid(:\d+)?$/.test(n));
  for (const c of pidCols) db.exec(`ALTER TABLE project_rollup DROP COLUMN ${q(c)}`);
  db.exec('CREATE INDEX ix_project_rollup__id ON project_rollup (project_id)');
  return true;
}

// ─── Table summaries + column stats (makes catalog/describe instant) ────────

const STATUS_COLS = ['status', 'status_value', 'state'];
const TOP_VALUES_MAX_DISTINCT = 25;

export function buildSummaries(db, tables, schema, asOf) {
  db.exec(`DROP TABLE IF EXISTS _tables`);
  db.exec(`CREATE TABLE _tables (
    table_name TEXT PRIMARY KEY, module TEXT, rows INTEGER, active_rows INTEGER, projects INTEGER,
    has_deleted_at INTEGER, status_column TEXT, min_created TEXT, max_created TEXT,
    parse_errors INTEGER, anomalies INTEGER, unknown_columns TEXT
  )`);
  db.exec(`DROP TABLE IF EXISTS _columns`);
  db.exec(`CREATE TABLE _columns (
    table_name TEXT, column_name TEXT, ordinal INTEGER, kind TEXT, source_type TEXT, description TEXT,
    non_null INTEGER, distinct_values INTEGER, min_value, max_value, top_values TEXT, anomalies INTEGER, anomaly_example TEXT,
    PRIMARY KEY (table_name, column_name)
  )`);
  db.exec(`DROP TABLE IF EXISTS _status_counts`);
  db.exec(`CREATE TABLE _status_counts (table_name TEXT, bim360_project_id TEXT, status TEXT, n INTEGER)`);

  const insT = db.query('INSERT INTO _tables VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  const insC = db.query('INSERT INTO _columns VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');

  for (const t of tables) {
    const names = t.columns.map((c) => c.name);
    const hasDel = names.includes('deleted_at');
    const active = hasDel ? db.query(`SELECT COUNT(*) AS n FROM ${q(t.table)} WHERE deleted_at IS NULL`).get().n : t.rows;
    const projects = names.includes('bim360_project_id')
      ? db.query(`SELECT COUNT(DISTINCT bim360_project_id) AS n FROM ${q(t.table)}${hasDel ? ' WHERE deleted_at IS NULL' : ''}`).get().n
      : null;
    const statusCol = STATUS_COLS.find((c) => names.includes(c)) ?? null;
    let minC = null;
    let maxC = null;
    if (names.includes('created_at')) {
      const r = db.query(`SELECT MIN(created_at) AS a, MAX(created_at) AS b FROM ${q(t.table)}`).get();
      minC = r.a;
      maxC = r.b;
    }
    const anomalyTotal = Object.values(t.anomalies).reduce((s, a) => s + a.count, 0);
    insT.run(t.table, moduleOf(t.table), t.rows, active, projects, hasDel ? 1 : 0, statusCol, minC, maxC, t.parseErrors, anomalyTotal, t.unknownColumns.join(',') || null);

    if (statusCol && names.includes('bim360_project_id')) {
      db.exec(`INSERT INTO _status_counts SELECT '${t.table}', bim360_project_id, ${q(statusCol)}, COUNT(*) FROM ${q(t.table)}${hasDel ? ' WHERE deleted_at IS NULL' : ''} GROUP BY 2, 3`);
    }

    // Column stats in one scan per table (capped for very wide/large tables).
    const sch = schema.get(t.table);
    let stats = {};
    if (t.rows > 0 && t.rows <= 3_000_000) {
      const exprs = names.map((c, i) => `COUNT(${q(c)}) AS n${i}, COUNT(DISTINCT ${q(c)}) AS d${i}, MIN(${q(c)}) AS mn${i}, MAX(${q(c)}) AS mx${i}`);
      // SQLite has a limit on result columns; chunk wide tables.
      for (let start = 0; start < exprs.length; start += 200) {
        const chunk = exprs.slice(start, start + 200);
        Object.assign(stats, db.query(`SELECT ${chunk.join(', ')} FROM ${q(t.table)}`).get());
      }
    }
    t.columns.forEach((c, i) => {
      const nn = stats[`n${i}`] ?? null;
      const dv = stats[`d${i}`] ?? null;
      let top = null;
      if (dv && dv <= TOP_VALUES_MAX_DISTINCT && c.name !== 'bim360_account_id') {
        top = JSON.stringify(
          db.query(`SELECT ${q(c.name)} AS v, COUNT(*) AS n FROM ${q(t.table)} WHERE ${q(c.name)} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT ${TOP_VALUES_MAX_DISTINCT}`).all().map((r) => [r.v, r.n])
        );
      }
      const short = (v) => (typeof v === 'string' && v.length > 80 ? v.slice(0, 80) + '…' : v);
      const meta = sch?.get(c.name);
      const an = t.anomalies[c.name];
      insC.run(t.table, c.name, i + 1, c.kind, meta?.sourceType ?? null, meta?.description || null, nn, dv, short(stats[`mn${i}`] ?? null), short(stats[`mx${i}`] ?? null), top, an?.count ?? 0, an?.example ?? null);
    });
  }
  db.exec('CREATE INDEX ix_status_counts ON _status_counts (bim360_project_id, table_name)');
}

/** Same column stats for views, so forma_describe on a view shows real status_group/status values. */
export function buildViewStats(db, views) {
  const insC = db.query('INSERT OR REPLACE INTO _columns VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const v of views) {
    if (v.status !== 'ok' || !v.rows || v.rows > 1_000_000) continue;
    const cols = db.query(`PRAGMA table_info(${q(v.name)})`).all().map((r) => r.name);
    // Long free-text columns aren't worth a distinct count.
    const skipDistinct = (c) => /description|question|response|summary|notes?$|content|scope_of_work|answer/.test(c);
    const exprs = cols.map((c, i) => (skipDistinct(c) ? `COUNT(${q(c)}) AS n${i}, NULL AS d${i}, NULL AS mn${i}, NULL AS mx${i}` : `COUNT(${q(c)}) AS n${i}, COUNT(DISTINCT ${q(c)}) AS d${i}, MIN(${q(c)}) AS mn${i}, MAX(${q(c)}) AS mx${i}`));
    let stats = {};
    for (let start = 0; start < exprs.length; start += 200) {
      Object.assign(stats, db.query(`SELECT ${exprs.slice(start, start + 200).join(', ')} FROM ${q(v.name)}`).get());
    }
    const short = (x) => (typeof x === 'string' && x.length > 80 ? x.slice(0, 80) + '…' : x);
    cols.forEach((c, i) => {
      const dv = stats[`d${i}`];
      let top = null;
      if (dv && dv <= TOP_VALUES_MAX_DISTINCT && !/_id$|^id$/.test(c)) {
        top = JSON.stringify(db.query(`SELECT ${q(c)} AS v, COUNT(*) AS n FROM ${q(v.name)} WHERE ${q(c)} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT ${TOP_VALUES_MAX_DISTINCT}`).all().map((r) => [r.v, r.n]));
      }
      insC.run(v.name, c, i + 1, null, null, null, stats[`n${i}`] ?? null, dv ?? null, short(stats[`mn${i}`] ?? null), short(stats[`mx${i}`] ?? null), top, 0, null);
    });
  }
}
