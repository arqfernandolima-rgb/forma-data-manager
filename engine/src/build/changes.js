/**
 * What changed since the previous extraction: compares the database being built with the
 * live one it is about to replace. Kept small (counts plus a few example names) because it is
 * stored in _meta, returned to the app for its history, and shown to Claude in forma_overview.
 *
 * The previous database is opened read-only on its own connection (not ATTACHed), so the
 * views on each side resolve against their own tables.
 */
import fs from 'node:fs';
import { Database } from 'bun:sqlite';
import { MODULES, moduleLabel } from '../modules.js';

/** Work items worth counting individually: new ones, and ones that moved to closed. */
export const CHANGE_ITEMS = [
  { key: 'issues', label: 'Issues', view: 'v_issues', id: 'issue_id' },
  { key: 'rfis', label: 'RFIs', view: 'v_rfis', id: 'rfi_id' },
  { key: 'submittals', label: 'Submittals', view: 'v_submittals', id: 'id' },
  { key: 'forms', label: 'Forms', view: 'v_forms', id: 'id' },
  { key: 'checklists', label: 'Checklists', view: 'v_checklists', id: 'id' },
];
const EXAMPLES = 5;
const DONE = new Set(['closed', 'void']);

const hasObject = (db, name) => !!db.query(`SELECT 1 FROM sqlite_master WHERE name = ?`).get(name);
const byName = (a, b) => String(a).localeCompare(String(b));

function readMeta(db) {
  if (!hasObject(db, '_meta')) return {};
  return Object.fromEntries(db.query('SELECT key, value FROM _meta').all().map((r) => [r.key, r.value]));
}

/** id -> status_group for one view, or null when the view isn't there. */
function statusMap(db, view, idCol) {
  if (!hasObject(db, view)) return null;
  const m = new Map();
  for (const r of db.query(`SELECT "${idCol}" AS id, status_group AS g FROM "${view}"`).all()) if (r.id != null) m.set(String(r.id), r.g);
  return m;
}

function projectMap(db) {
  if (!hasObject(db, 'v_projects')) return null;
  const m = new Map();
  for (const r of db.query('SELECT project_id AS id, project_name AS name, status FROM v_projects').all()) if (r.id != null) m.set(String(r.id), r);
  return m;
}

function mainTableRows(db) {
  if (!hasObject(db, '_tables')) return new Map();
  return new Map(db.query('SELECT table_name AS t, active_rows AS n FROM _tables').all().map((r) => [r.t, r.n]));
}

/**
 * @param {Database} db       the new database (open, read/write)
 * @param {string} prevPath   file of the database it replaces
 * @param {{ totalRows: number }} opts
 * @returns {object|null}     null when there is no previous database to compare with
 */
export function computeChanges(db, prevPath, { totalRows }) {
  if (!prevPath || !fs.existsSync(prevPath)) return null;
  const prev = new Database(prevPath, { readonly: true });
  try {
    const meta = readMeta(prev);
    const out = {
      previous: { as_of: meta.as_of ?? null, built_at: meta.built_at ?? null, extraction_created_at: meta.extraction_created_at ?? null },
      rows: { before: Number(meta.total_rows) || null, after: totalRows },
      projects: null,
      items: [],
      modules: [],
    };

    // Projects: new, gone, and status changes (e.g. active -> archived).
    const pBefore = projectMap(prev);
    const pAfter = projectMap(db);
    if (pBefore && pAfter) {
      const added = [...pAfter.keys()].filter((id) => !pBefore.has(id)).map((id) => pAfter.get(id).name);
      const removed = [...pBefore.keys()].filter((id) => !pAfter.has(id)).map((id) => pBefore.get(id).name);
      const changed = [...pAfter.entries()]
        .filter(([id, p]) => pBefore.has(id) && (pBefore.get(id).status ?? null) !== (p.status ?? null))
        .map(([id, p]) => ({ name: p.name, from: pBefore.get(id).status ?? null, to: p.status ?? null }));
      out.projects = {
        before: pBefore.size,
        after: pAfter.size,
        added: added.length,
        added_names: added.sort(byName).slice(0, EXAMPLES),
        removed: removed.length,
        removed_names: removed.sort(byName).slice(0, EXAMPLES),
        status_changed: changed.length,
        status_examples: changed.sort((a, b) => byName(a.name, b.name)).slice(0, EXAMPLES),
      };
    }

    // Work items: how many are new, and how many were closed since last time.
    for (const it of CHANGE_ITEMS) {
      try {
        const before = statusMap(prev, it.view, it.id);
        const after = statusMap(db, it.view, it.id);
        if (!before || !after) continue;
        let added = 0;
        let closed = 0;
        let openBefore = 0;
        let openAfter = 0;
        for (const g of before.values()) if (g === 'open') openBefore++;
        for (const [id, g] of after) {
          if (g === 'open') openAfter++;
          if (!before.has(id)) added++;
          else if (g === 'closed' && !DONE.has(before.get(id))) closed++;
        }
        out.items.push({ key: it.key, label: it.label, before: before.size, after: after.size, new: added, closed, open_before: openBefore, open_after: openAfter });
      } catch {
        /* a view that changed shape between versions: skip it */
      }
    }

    // Every module's main table: how many rows it had before and now (only the ones that changed).
    const tBefore = mainTableRows(prev);
    const tAfter = mainTableRows(db);
    for (const [mod, def] of Object.entries(MODULES)) {
      if (!def.main || (!tAfter.has(def.main) && !tBefore.has(def.main))) continue;
      const before = tBefore.get(def.main) ?? 0;
      const after = tAfter.get(def.main) ?? 0;
      if (before !== after) out.modules.push({ module: mod, label: moduleLabel(mod), before, after });
    }
    out.modules.sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before));
    return out;
  } finally {
    prev.close();
  }
}
