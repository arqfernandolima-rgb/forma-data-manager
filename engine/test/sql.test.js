import { expect, test } from 'bun:test';
import { prepareSql, referencedTables, similar } from '../src/server/sql.js';

test('strips comments and trailing semicolons', () => {
  expect(prepareSql('-- note\n/* more */ SELECT 1;  ').sql).toBe('SELECT 1');
  expect(prepareSql('WITH a AS (SELECT 1) SELECT * FROM a;;').sql).toBe('WITH a AS (SELECT 1) SELECT * FROM a');
});

test('semicolons inside strings are fine', () => {
  expect(prepareSql("SELECT 'a;b' AS x").sql).toBe("SELECT 'a;b' AS x");
});

test('rejects multiple statements and writes', () => {
  expect(prepareSql('SELECT 1; DELETE FROM t').error).toMatch(/one SQL statement/);
  expect(prepareSql('DELETE FROM t').error).toMatch(/SELECT or WITH/);
  expect(prepareSql('PRAGMA table_info(x)').error).toMatch(/SELECT or WITH/);
  expect(prepareSql("SELECT load_extension('x')").error).toMatch(/load_extension/);
});

test('helpers for error hints', () => {
  expect(referencedTables('SELECT * FROM v_rfis r JOIN "admin_users" u ON 1')).toEqual(['v_rfis', 'admin_users']);
  expect(similar('statuss', ['v_rfis.status', 'v_rfis.title', 'v_rfis.status_group'])[0]).toBe('v_rfis.status');
});
