/**
 * MCP tools. Design goals:
 *  - Accurate: canonical views + precomputed rollups, real status values surfaced before filtering,
 *    ambiguous project names are never silently merged.
 *  - Fast: one call should usually be enough; results are compact (columns + rows arrays),
 *    sized to fit comfortably in a model's context.
 */
import { z } from 'zod';
import { prepareSql, referencedTables, similar } from './sql.js';
import { MODULES, moduleLabel, moduleOf } from '../modules.js';

const MAX_CHARS = 60_000;
const CELL_MAX = 1_500;

const q = (id) => `"${String(id).replace(/"/g, '""')}"`;

function cell(v) {
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string' && v.length > CELL_MAX) return `${v.slice(0, CELL_MAX)}…[+${v.length - CELL_MAX} chars]`;
  return v;
}

function text(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

/** Fit a columns/rows payload under MAX_CHARS by dropping trailing rows. */
function fit(payload) {
  payload.rows = payload.rows.map((r) => r.map(cell));
  let s = JSON.stringify(payload);
  if (s.length <= MAX_CHARS) return payload;
  let lo = 0;
  let hi = payload.rows.length;
  const all = payload.rows;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    payload.rows = all.slice(0, mid);
    if (JSON.stringify(payload).length <= MAX_CHARS - 200) lo = mid;
    else hi = mid - 1;
  }
  payload.rows = all.slice(0, lo);
  payload.truncated = true;
  payload.note = `Output trimmed to ${lo} rows to fit the response size limit. Aggregate in SQL or select fewer columns.`;
  return payload;
}

function rowsToTable(rows) {
  if (!rows.length) return { columns: [], rows: [] };
  const columns = Object.keys(rows[0]);
  return { columns, rows: rows.map((r) => columns.map((c) => r[c])) };
}

function daysBetween(isoDate, now = new Date()) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return Math.floor((now - d) / 86_400_000);
}

export function registerTools(server, store) {
  const notReady = () =>
    text({
      error: store.error || 'The database is still loading. Try again in a moment.',
      hint: 'If this persists, open the Forma Data Manager app and run a sync.',
    });

  const asOf = () => store.meta.as_of;

  // ── forma_overview ──────────────────────────────────────────────────────
  server.registerTool(
    'forma_overview',
    {
      title: 'Overview and data freshness',
      description:
        'Start here once per conversation. Returns the data date (as_of), how old it is, what changed since the previous extraction, project counts by status/classification, which modules have data, the analytical views (with row counts and what they contain), and the conventions to follow. Quote "Data as of <as_of>" in your answer.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => {
      if (!store.ready) return notReady();
      const m = store.meta;
      const age = m.as_of ? daysBetween(m.as_of) : null;
      const freshness =
        age == null ? 'unknown' : age <= 2 ? 'current' : age <= 7 ? `${age} days old` : `STALE: ${age} days old. Tell the user the numbers reflect ${m.as_of}, and suggest running a sync in Forma Data Manager.`;
      const base = store.memo('overview', () => {
          const tables = store.all('SELECT table_name, module, rows, active_rows, projects FROM _tables');
          const byModule = new Map();
          for (const t of tables) {
            const e = byModule.get(t.module) ?? { module: t.module, label: moduleLabel(t.module), tables: 0, rows: 0, main_table: MODULES[t.module]?.main ?? null, projects_with_data: null };
            e.tables++;
            e.rows += t.active_rows ?? t.rows;
            if (t.table_name === e.main_table) e.projects_with_data = t.projects;
            byModule.set(t.module, e);
          }
          const modules = [...byModule.values()].filter((e) => e.rows > 0).sort((a, b) => b.rows - a.rows);
          let projects = null;
          if (store.objects().has('v_projects')) {
            const by = (col) => Object.fromEntries(store.all(`SELECT COALESCE(${col}, '(none)') AS k, COUNT(*) AS n FROM v_projects GROUP BY 1 ORDER BY 2 DESC`).map((r) => [r.k, r.n]));
            projects = {
              total: store.get('SELECT COUNT(*) AS n FROM v_projects').n,
              by_status: by('status'),
              by_classification: by('classification'),
              looks_like_test: store.get('SELECT SUM(looks_like_test) AS n FROM v_projects').n,
            };
          }
          const views = store.all(`SELECT name, rows, description FROM _views WHERE status = 'ok'`);
          const failed = store.all(`SELECT name, error FROM _views WHERE status != 'ok'`);
          let changes = null;
          try {
            changes = m.changes ? JSON.parse(m.changes) : null;
            if (changes?.modules) changes.modules = changes.modules.slice(0, 8);
          } catch {}
          return {
            extraction_created_at: m.extraction_created_at,
            region: m.extraction_region,
            built_at: m.built_at,
            // Compared with the extraction this one replaced: new/closed items are matched by ID.
            changes_since_previous: changes ?? undefined,
            projects,
            modules,
            views,
            precomputed: {
              project_rollup:
                'One row per project: open/overdue counts for issues, RFIs, submittals, meeting items, checklists, forms; budget totals and forecast variance; open change-order chains and exposure; late schedule activities. NULL = module has no data for that project.',
            },
            unavailable_views: failed.length ? failed : undefined,
            conventions: [
              'Views exclude soft-deleted rows and already resolve names; no deleted_at filter needed on v_* views.',
              "status_group is 'draft' | 'open' | 'closed' | 'void' (meeting items also 'info'). Use it for open/closed counts.",
              'is_overdue / days_overdue / age_days are measured against as_of, not today.',
              "Booleans are 1/0. Timestamps are 'YYYY-MM-DD HH:MM:SS' UTC; compare with date(col) >= '2026-01-01'.",
              'Change-order exposure: use v_change_order_chains (one row per real change), never SUM over v_change_orders.',
              'forecast_variance < 0 is a projected overrun. Sum budget lines with has_children = 0.',
              'Label projects with is_production = 0 or looks_like_test = 1 as demo/template/training; do not drop them silently.',
              'Who holds an item: assignee_name / manager_name / subcontractor_name / ball_in_court_names cover users, companies and roles.',
              'Building a dashboard, chart or visual summary? Call forma_dashboard_guide once first, and keep it quick: one inline visual or one small artifact.',
            ],
            warnings: JSON.parse(m.warnings || '[]'),
          };
        });
      return text({ as_of: m.as_of, data_age_days: age, freshness, ...base });
    }
  );

  // ── forma_catalog ───────────────────────────────────────────────────────
  server.registerTool(
    'forma_catalog',
    {
      title: 'Find tables and columns',
      description:
        'Find where data lives. No arguments: every module with its tables and row counts. module="cost": that module\'s tables with their columns. search="retention": tables and columns whose name or official Autodesk description mentions the term. Prefer v_* views (see forma_overview) when one covers the question.',
      inputSchema: {
        module: z.string().optional().describe('Module prefix, e.g. issues, rfis, cost, assets, schedule, forms, admin'),
        search: z.string().optional().describe('Term to look for in table names, column names and column descriptions'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ module, search }) => {
      if (!store.ready) return notReady();
      if (search) {
        const like = `%${search.toLowerCase()}%`;
        const rows = store.all(
          `SELECT c.table_name AS "table", c.column_name AS "column", c.kind, t.rows, c.description
           FROM _columns c LEFT JOIN _tables t ON t.table_name = c.table_name
           WHERE lower(c.column_name) LIKE ? OR lower(c.table_name) LIKE ? OR lower(COALESCE(c.description, '')) LIKE ?
           ORDER BY (lower(c.column_name) LIKE ?) DESC, t.rows DESC LIMIT 150`,
          like,
          like,
          like,
          like
        );
        return text({ as_of: asOf(), search, ...fit(rowsToTable(rows)) });
      }
      if (module) {
        const mod = module.toLowerCase().replace(/[^a-z0-9]/g, '');
        const tables = store.all(`SELECT table_name, rows, active_rows, projects, has_deleted_at FROM _tables WHERE module = ? ORDER BY rows DESC`, mod);
        if (!tables.length) {
          const mods = store.all('SELECT DISTINCT module FROM _tables ORDER BY 1').map((r) => r.module);
          return text({ error: `No module "${module}".`, modules: mods });
        }
        const out = tables.map((t) => ({
          table: t.table_name,
          rows: t.rows,
          active_rows: t.has_deleted_at ? t.active_rows : undefined,
          columns: store.all('SELECT column_name FROM _columns WHERE table_name = ? ORDER BY ordinal', t.table_name).map((c) => c.column_name).join(', '),
        }));
        const views = store.all(`SELECT name, rows FROM _views WHERE status = 'ok' AND module = ?`, mod);
        return text({ as_of: asOf(), module: mod, label: moduleLabel(mod), views: views.length ? views : undefined, tables: out });
      }
      const rows = store.all('SELECT module, table_name, rows FROM _tables ORDER BY module, rows DESC');
      const by = new Map();
      for (const r of rows) {
        if (!by.has(r.module)) by.set(r.module, []);
        by.get(r.module).push(`${r.table_name.slice(r.module.length + 1) || r.table_name}(${r.rows})`);
      }
      return text({
        as_of: asOf(),
        note: 'Table names are <module>_<name>. Counts in parentheses. Call again with module=... for columns.',
        modules: [...by.entries()].map(([m, list]) => ({ module: m, label: moduleLabel(m), tables: list.join(', ') })),
      });
    }
  );

  // ── forma_describe ──────────────────────────────────────────────────────
  server.registerTool(
    'forma_describe',
    {
      title: 'Describe a table or view',
      description:
        'Columns of one table or view with type, Autodesk\'s description, how many rows have a value, distinct counts, min/max, and the actual values (with counts) for low-cardinality columns such as status. Call this before filtering on a column whose values you haven\'t seen, so filters match real values.',
      inputSchema: {
        name: z.string().describe('Table or view name, e.g. v_rfis or cost_change_orders'),
        sample_rows: z.number().int().min(0).max(10).default(2).describe('Example rows to include'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ name, sample_rows }) => {
      if (!store.ready) return notReady();
      const objs = store.objects();
      const n = String(name).trim().toLowerCase();
      if (!objs.has(n) || n.startsWith('_')) {
        return text({ error: `No table or view named "${name}".`, did_you_mean: similar(n, [...objs.keys()].filter((k) => !k.startsWith('_'))) });
      }
      const isView = objs.get(n) === 'view';
      const info = isView ? store.get('SELECT rows, description FROM _views WHERE name = ?', n) : store.get('SELECT rows, active_rows, has_deleted_at, module, projects FROM _tables WHERE table_name = ?', n);
      const stats = store.all('SELECT column_name, kind, description, non_null, distinct_values, min_value, max_value, top_values FROM _columns WHERE table_name = ? ORDER BY ordinal', n);
      let columns;
      if (stats.length) {
        columns = stats.map((c) => {
          const o = { name: c.column_name };
          if (c.kind) o.kind = c.kind;
          if (c.description) o.description = c.description;
          o.filled = c.non_null;
          o.distinct = c.distinct_values;
          if (c.top_values) o.values = JSON.parse(c.top_values);
          else if (c.min_value != null) o.range = [c.min_value, c.max_value];
          return o;
        });
      } else {
        columns = store.columnsOf(n).map((c) => ({ name: c }));
      }
      let sample;
      if (sample_rows > 0) {
        try {
          sample = fit(rowsToTable(store.all(`SELECT * FROM ${q(n)} LIMIT ${sample_rows}`)));
        } catch {}
      }
      return text({
        as_of: asOf(),
        name: n,
        type: isView ? 'view' : 'table',
        ...info,
        note: isView ? 'View: soft-deleted rows already excluded, names resolved.' : info?.has_deleted_at ? 'Has deleted_at: add WHERE deleted_at IS NULL for active rows.' : 'No deleted_at column in this extract.',
        columns,
        sample,
      });
    }
  );

  // ── forma_sql ───────────────────────────────────────────────────────────
  server.registerTool(
    'forma_sql',
    {
      title: 'Run a read-only SQL query',
      description:
        'Run one SQLite SELECT/WITH query. Prefer v_* views and project_rollup. Aggregate with GROUP BY instead of pulling raw rows. Returns {columns, rows} capped at max_rows; truncated=true means there were more. Comments and a trailing semicolon are fine. Queries running longer than 30s are stopped.',
      inputSchema: {
        sql: z.string().min(8).describe('A single SELECT or WITH statement'),
        max_rows: z.number().int().min(1).max(2000).default(200).describe('Maximum rows to return'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ sql, max_rows }) => {
      if (!store.ready) return notReady();
      const prep = prepareSql(sql);
      if (prep.error) return text({ error: prep.error });
      const res = await store.runQuery(prep.sql, { maxRows: max_rows, timeoutMs: Number(process.env.FORMA_QUERY_TIMEOUT_MS) || 30_000 });
      if (!res.ok) {
        const out = { error: res.error };
        const col = /no such column: ([\w.]+)/i.exec(res.error);
        const tbl = /no such table: ([\w.]+)/i.exec(res.error);
        if (col) {
          const bare = col[1].split('.').pop();
          const cands = referencedTables(prep.sql).flatMap((t) => store.columnsOf(t).map((c) => `${t}.${c}`));
          out.similar_columns = similar(bare, cands, 8);
          out.hint = 'Use forma_describe on the table to see its real columns.';
        }
        if (tbl) out.similar_tables = similar(tbl[1], [...store.objects().keys()].filter((k) => !k.startsWith('_')));
        return text(out);
      }
      return text({ as_of: asOf(), ...fit({ columns: res.columns, rows: res.rows, row_count: res.rows.length, truncated: res.truncated || undefined, ms: res.ms }) });
    }
  );

  // ── forma_find_projects ─────────────────────────────────────────────────
  server.registerTool(
    'forma_find_projects',
    {
      title: 'Find projects',
      description:
        'The authoritative way to answer "which/how many projects". Partial, case-insensitive name match plus optional filters. Returns total_matched (exact count) and the projects, with is_production and looks_like_test flags so demos/templates can be labeled.',
      inputSchema: {
        name: z.string().optional().describe('Part of the project name or job number'),
        status: z.string().optional().describe('active, archived, inactive'),
        type: z.string().optional().describe('Part of the project type, e.g. Data Center, Retail'),
        production_only: z.boolean().default(false).describe('Only classification = production and not test-looking'),
        limit: z.number().int().min(1).max(5000).default(100),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ name, status, type, production_only, limit }) => {
      if (!store.ready) return notReady();
      if (!store.objects().has('v_projects')) return text({ error: 'v_projects is not available in this extract.' });
      const where = [];
      const params = [];
      if (name) {
        where.push(`(lower(project_name) LIKE ? OR lower(COALESCE(job_number, '')) LIKE ?)`);
        params.push(`%${name.toLowerCase()}%`, `%${name.toLowerCase()}%`);
      }
      if (status) {
        where.push('lower(status) = ?');
        params.push(status.toLowerCase());
      }
      if (type) {
        where.push('lower(COALESCE(project_type, \'\')) LIKE ?');
        params.push(`%${type.toLowerCase()}%`);
      }
      if (production_only) where.push(`COALESCE(is_production, 1) = 1 AND looks_like_test = 0`);
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = store.get(`SELECT COUNT(*) AS n FROM v_projects ${w}`, ...params).n;
      const rows = store.all(
        `SELECT project_id, project_name, status, project_type, classification, is_production, looks_like_test, job_number, start_date, end_date, city, state_or_province
         FROM v_projects ${w} ORDER BY project_name COLLATE NOCASE LIMIT ${limit}`,
        ...params
      );
      return text({ as_of: asOf(), total_matched: total, filters: { name, status, type, production_only }, ...fit(rowsToTable(rows)) });
    }
  );

  // ── forma_project_summary ───────────────────────────────────────────────
  server.registerTool(
    'forma_project_summary',
    {
      title: 'One project across all modules',
      description:
        'Everything about ONE project: details, precomputed rollup (open/overdue counts, cost totals, change-order exposure), record counts by status for every module, and the most overdue items. Pass a project id or a name. If several projects match, you get the candidates back to choose from; results are never merged across projects.',
      inputSchema: {
        project: z.string().min(2).describe('Project id, exact name, or part of the name'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ project }) => {
      if (!store.ready) return notReady();
      if (!store.objects().has('v_projects')) return text({ error: 'v_projects is not available in this extract.' });
      const p = String(project).trim();
      let matches = store.all('SELECT project_id, project_name, status, classification FROM v_projects WHERE project_id = ? OR lower(project_name) = lower(?)', p, p);
      if (!matches.length) {
        matches = store.all(`SELECT project_id, project_name, status, classification FROM v_projects WHERE lower(project_name) LIKE ? ORDER BY (status = 'active') DESC, project_name LIMIT 21`, `%${p.toLowerCase()}%`);
      }
      if (!matches.length) return text({ error: `No project matches "${project}".`, hint: 'Try forma_find_projects with a shorter name.' });
      if (matches.length > 1) {
        return text({ as_of: asOf(), ambiguous: true, message: `${matches.length >= 21 ? '20+' : matches.length} projects match "${project}". Ask the user which one, or call again with the project_id.`, ...fit(rowsToTable(matches.slice(0, 20))) });
      }
      const pid = matches[0].project_id;
      const details = store.get('SELECT * FROM v_projects WHERE project_id = ?', pid);
      const rollup = store.objects().has('project_rollup') ? store.get('SELECT * FROM project_rollup WHERE project_id = ?', pid) : null;
      if (rollup) for (const k of Object.keys(rollup)) if (rollup[k] == null || ['project_id', 'project_name', 'status', 'project_type', 'classification', 'is_production', 'looks_like_test'].includes(k)) delete rollup[k];
      const counts = {};
      for (const r of store.all('SELECT table_name, status, n FROM _status_counts WHERE bim360_project_id = ? ORDER BY table_name, n DESC', pid)) {
        (counts[r.table_name] ??= {})[r.status ?? '(none)'] = r.n;
      }
      const attention = [];
      const pull = (view, label, idCol, titleCol) => {
        if (!store.objects().has(view)) return;
        for (const r of store.all(`SELECT ${idCol} AS ref, ${titleCol} AS title, status, due_date, days_overdue FROM ${view} WHERE bim360_project_id = ? AND is_overdue = 1 ORDER BY days_overdue DESC LIMIT 5`, pid)) {
          attention.push({ module: label, ...r });
        }
      };
      pull('v_all_issues', 'issue', 'display_id', 'title');
      pull('v_rfis', 'rfi', 'custom_identifier', 'title');
      pull('v_submittals', 'submittal', 'COALESCE(custom_identifier, identifier)', 'title');
      pull('v_meeting_items', 'meeting_item', 'item_id', 'substr(description, 1, 120)');
      return text({
        as_of: asOf(),
        project: details,
        rollup,
        status_counts_by_table: counts,
        most_overdue: attention.length ? fit(rowsToTable(attention)) : 'No overdue issues, RFIs, submittals or meeting items.',
      });
    }
  );

  // ── forma_search ────────────────────────────────────────────────────────
  server.registerTool(
    'forma_search',
    {
      title: 'Full-text search',
      description:
        'Search free text across issues, RFIs, submittals, meetings and action items, checklists, daily-log notes, forms, assets, change orders, contracts, budgets, schedule activities and photos. Plain words work; FTS5 syntax ("exact phrase", term*, OR, NOT) is supported. Filter by module or project. Active (non-deleted) records only.',
      inputSchema: {
        query: z.string().min(2),
        module: z.string().optional().describe('Restrict to a module, e.g. rfis, issues, cost'),
        project: z.string().optional().describe('Restrict to a project id or exact project name'),
        limit: z.number().int().min(1).max(100).default(25),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ query, module, project, limit }) => {
      if (!store.ready) return notReady();
      if (!store.objects().has('_fts')) return text({ error: 'Search index not available in this database.' });
      const where = ['_fts MATCH ?'];
      const params = [];
      if (module) {
        where.push('source_table LIKE ?');
        params.push(`${module.toLowerCase()}%`);
      }
      if (project) {
        const pid = store.get('SELECT project_id FROM v_projects WHERE project_id = ? OR lower(project_name) = lower(?) LIMIT 1', project, project)?.project_id;
        if (!pid) return text({ error: `No project "${project}". Use forma_find_projects to get the exact name or id.` });
        where.push('bim360_project_id = ?');
        params.push(pid);
      }
      const run = (match) =>
        store.all(
          `SELECT source_table, source_rowid, bim360_project_id, title, status, snippet(_fts, 5, '[', ']', '…', 16) AS excerpt
           FROM _fts WHERE ${where.join(' AND ')} ORDER BY rank LIMIT ${limit}`,
          match,
          ...params
        );
      let rows;
      try {
        rows = run(query);
      } catch {
        // Not valid FTS syntax (hyphens, colons, quotes…): search the words as plain terms.
        const words = query.match(/[\p{L}\p{N}]+/gu) ?? [];
        if (!words.length) return text({ results: [] });
        rows = run(words.map((w) => `"${w}"`).join(' '));
      }
      const projName = (id) => (id ? store.memo(`pname:${id}`, () => store.get('SELECT name FROM admin_projects WHERE id = ?', id)?.name ?? id) : null);
      const idOf = (table, rowid) => {
        const cols = store.columnsOf(table);
        const idc = ['id', 'issue_id', 'rfi_id', 'item_id'].find((c) => cols.includes(c));
        return idc ? store.get(`SELECT ${q(idc)} AS v FROM ${q(table)} WHERE rowid = ?`, rowid)?.v : null;
      };
      const results = rows.map((r) => ({
        table: r.source_table,
        module: moduleOf(r.source_table),
        id: idOf(r.source_table, r.source_rowid),
        project: projName(r.bim360_project_id),
        title: r.title,
        status: r.status,
        excerpt: r.excerpt,
      }));
      return text({ as_of: asOf(), query, count: results.length, ...fit(rowsToTable(results)) });
    }
  );
}
