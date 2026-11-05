import { beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { buildDatabase } from '../src/build/index.js';
import { readPointer, listDatabases, writePointer } from '../src/paths.js';
import { tmpDir, writeMiniExtract } from './helpers.js';

let dataDir;
let db;
let ids;
let result;

beforeAll(async () => {
  const src = tmpDir('forma-src-');
  ids = writeMiniExtract(src);
  dataDir = tmpDir('forma-data-');
  result = await buildDatabase({ csvDir: src, dataDir });
  db = new Database(path.join(dataDir, readPointer(dataDir).db), { readonly: true });
});

const one = (sql, ...p) => db.query(sql).get(...p);
const all = (sql, ...p) => db.query(sql).all(...p);

describe('load', () => {
  test('every row loaded, header-only CSV still creates its table', () => {
    expect(result.table_counts.issues_issues).toBe(4);
    expect(one('SELECT COUNT(*) AS n FROM forms_forms').n).toBe(0);
  });
  test('as_of comes from the extract metadata', () => {
    expect(result.as_of).toBe('2026-06-08');
  });
  test('typed values', () => {
    const p = one('SELECT * FROM admin_projects WHERE id = ?', ids.P1);
    expect(p.value).toBe(0); // zero, not NULL
    expect(p.acc_project).toBe(1);
    expect(p.job_number).toBe('00123'); // leading zeros kept (text column)
    expect(p.postal_code).toBe('07924'); // tab trimmed
    expect(p.type).toBe('Hospital'); // trailing space trimmed
    const codes = all('SELECT number, typeof(number) AS t FROM cost_change_orders ORDER BY id').map((r) => [r.number, r.t]);
    expect(codes).toEqual([[1, 'integer'], ['SUB-14-000-0001', 'text'], ['007', 'text'], [2, 'integer']]);
    expect(one("SELECT last_sign_in AS v FROM admin_users WHERE name = 'Ana Silva'").v).toBe('2019-10-24 00:32:46');
  });
  test('multi-line and quoted text survive', () => {
    expect(one("SELECT description AS d FROM issues_issues WHERE issue_id = 'I4'").d).toBe('multi\nline');
    expect(one("SELECT description AS d FROM issues_issues WHERE issue_id = 'I1'").d).toBe('Water on floor, "urgent"');
  });
});

describe('views', () => {
  test('all views build, including v_rfis on an extract without rfis.deleted_at', () => {
    const bad = all(`SELECT name, error FROM _views WHERE status = 'error'`);
    expect(bad).toEqual([]);
    expect(one(`SELECT status FROM _views WHERE name = 'v_rfis'`).status).toBe('ok');
  });
  test('duplicate user rows never duplicate issues', () => {
    expect(one('SELECT COUNT(*) AS n FROM v_issues').n).toBe(3); // 4 minus 1 soft-deleted
    expect(one(`SELECT assignee_name AS a FROM v_issues WHERE issue_id = 'I1'`).a).toBe('Ana Silva');
  });
  test('status_group, overdue and age use the extract date', () => {
    const i1 = one(`SELECT status_group, is_overdue, days_overdue, age_days, type_name FROM v_issues WHERE issue_id = 'I1'`);
    expect(i1).toEqual({ status_group: 'open', is_overdue: 1, days_overdue: 38, age_days: 68, type_name: 'Quality' });
    expect(one(`SELECT is_overdue FROM v_issues WHERE issue_id = 'I2'`).is_overdue).toBe(0); // closed
    expect(one(`SELECT status_group FROM v_rfis WHERE rfi_id = 'R1'`).status_group).toBe('open'); // openRev1
  });
  test('change-order chains dedupe by name (trailing space included)', () => {
    const c = one(`SELECT form_count, exposure, open_legs FROM v_change_order_chains WHERE chain_key = 'add heater'`);
    expect(c).toEqual({ form_count: 3, exposure: 5330, open_legs: 1 });
  });
  test('budget parents are flagged so sums can skip them', () => {
    expect(all('SELECT id, has_children, is_overrun FROM v_cost_budgets ORDER BY id')).toEqual([
      { id: 'B0', has_children: 1, is_overrun: 1 },
      { id: 'B1', has_children: 0, is_overrun: 1 },
      { id: 'B2', has_children: 0, is_overrun: 0 },
    ]);
  });
  test('schedule completion is 0-100 and WBS rows are not "late"', () => {
    expect(all('SELECT id, completion_pct, is_late FROM v_schedule_activities ORDER BY id')).toEqual([
      { id: 'A1', completion_pct: 0, is_late: 1 },
      { id: 'A2', completion_pct: 100, is_late: 0 },
      { id: 'A3', completion_pct: 50, is_late: null },
    ]);
  });
  test('test/demo projects are flagged, not dropped', () => {
    expect(all('SELECT project_name, is_production, looks_like_test FROM v_projects ORDER BY project_name')).toEqual([
      { project_name: 'Riverside Hospital', is_production: 1, looks_like_test: 0 },
      { project_name: 'Training Sandbox', is_production: 0, looks_like_test: 1 },
    ]);
  });
});

describe('rollup and summaries', () => {
  test('project_rollup', () => {
    const r = one('SELECT * FROM project_rollup WHERE project_id = ?', ids.P1);
    expect(r.issues_open).toBe(1);
    expect(r.issues_overdue).toBe(1);
    expect(r.rfis_open).toBe(1);
    expect(r.rfis_open_cost_impact).toBe(1);
    expect(r.budget_original).toBe(300); // children only, parent skipped
    expect(r.forecast_variance).toBe(-50);
    expect(r.change_orders_open).toBe(1);
    expect(r.change_order_open_exposure).toBe(5330);
    const empty = one('SELECT rfis_open, budget_original FROM project_rollup WHERE project_id = ?', ids.P2);
    expect(empty).toEqual({ rfis_open: null, budget_original: null }); // "module empty", not zero
  });
  test('column stats carry real values and Autodesk descriptions', () => {
    const c = one(`SELECT description, top_values FROM _columns WHERE table_name = 'issues_issues' AND column_name = 'status'`);
    expect(c.description).toBe('status of issues');
    expect(JSON.parse(c.top_values).map((x) => x[0]).sort()).toEqual(['closed', 'draft', 'open']);
    const v = one(`SELECT top_values FROM _columns WHERE table_name = 'v_rfis' AND column_name = 'status_group'`);
    expect(JSON.parse(v.top_values).sort()).toEqual([['closed', 1], ['open', 1]]);
  });
  test('full-text search index', () => {
    const hits = all(`SELECT source_table, title FROM _fts WHERE _fts MATCH 'fire pump'`);
    expect(hits).toEqual([{ source_table: 'issues_issues', title: 'Leak at fire pump room' }]);
  });
  test('build metadata', () => {
    const meta = Object.fromEntries(all('SELECT key, value FROM _meta').map((r) => [r.key, r.value]));
    expect(meta.build_complete).toBe('1');
    expect(meta.schema_version).toBe('4');
  });
});

describe('file handles', () => {
  // Regression: on Windows, a build that leaves its SQLite handle open can't rename
  // forma-*.db.partial to forma-*.db (EBUSY). Unfinalized db.prepare() statements cause this.
  // Linux allows the rename, so check /proc for leftover handles instead.
  test.skipIf(!fs.existsSync('/proc/self/fd'))('the build process holds no handle on any database file afterwards', async () => {
    const src = tmpDir('forma-src-fd-');
    writeMiniExtract(src);
    const dir = tmpDir('forma-data-fd-');
    await buildDatabase({ csvDir: src, dataDir: dir });
    const open = fs.readdirSync('/proc/self/fd').filter((fd) => {
      try {
        return fs.readlinkSync(`/proc/self/fd/${fd}`).startsWith(dir);
      } catch {
        return false;
      }
    });
    expect(open).toEqual([]);
  });
});

describe('versioning', () => {
  test('a second build becomes live and keeps the previous one', async () => {
    const src = tmpDir('forma-src2-');
    writeMiniExtract(src, { omitRfiDeletedAt: false });
    await Bun.sleep(1100); // new UTC-second stamp
    const first = readPointer(dataDir).db;
    await buildDatabase({ csvDir: src, dataDir, keep: 2 });
    const now = readPointer(dataDir).db;
    expect(now).not.toBe(first);
    expect(listDatabases(dataDir)).toEqual([now, first]);
  });
  test('a much smaller extract is rejected unless forced', async () => {
    const live = readPointer(dataDir);
    writePointer(dataDir, { ...live, total_rows: 10_000 });
    const src = tmpDir('forma-src3-');
    writeMiniExtract(src);
    await expect(buildDatabase({ csvDir: src, dataDir })).rejects.toThrow(/less than half/);
    expect(readPointer(dataDir).db).toBe(live.db);
    expect(fs.readdirSync(dataDir).some((f) => f.endsWith('.partial'))).toBe(false);
  });
});
