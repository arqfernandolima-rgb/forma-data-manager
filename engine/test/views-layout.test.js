/**
 * Every view must compile against the real Data Connector table layout (June 2026),
 * which differs from older extracts (for example rfis_rfis has no deleted_at).
 * Builds empty tables with exactly those columns and runs the view builder.
 */
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import layout from './fixtures/schema-columns-2026-06.json';
import { makeContext, VIEW_DEFS } from '../src/build/views.js';
import { buildViews } from '../src/build/derived.js';

test('all views build on the June 2026 layout', () => {
  const db = new Database(':memory:');
  for (const [table, cols] of Object.entries(layout.tables)) {
    db.exec(`CREATE TABLE "${table}" (${cols.map((c) => `"${c}"`).join(', ')})`);
  }
  const results = buildViews(db, makeContext(db, '2026-06-08'));
  const notOk = results.filter((r) => r.status !== 'ok');
  expect(notOk).toEqual([]);
  expect(results.length).toBe(VIEW_DEFS.length);
});

test('views degrade instead of failing when columns are missing', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE admin_projects (id, name)');
  db.exec('CREATE TABLE rfis_rfis (id, bim360_project_id, title)'); // no status, no dates, no deleted_at
  const results = buildViews(db, makeContext(db, '2026-06-08'));
  expect(results.find((r) => r.name === 'v_rfis').status).toBe('ok');
  expect(results.find((r) => r.name === 'v_projects').status).toBe('ok');
  expect(results.find((r) => r.name === 'v_issues').status).toBe('skipped');
});
