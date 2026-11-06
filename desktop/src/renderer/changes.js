/**
 * Short, plain-language summary of what changed between two extractions.
 * Input: the `changes` object the engine computes at build time (engine/src/build/changes.js).
 * Loaded by the window (index.html, before app.js) and by the main process / tests via require().
 */
(function (root) {
  'use strict';

  const num = (x) => Number(x || 0).toLocaleString();
  const signed = (d) => (d > 0 ? `+${num(d)}` : d < 0 ? `−${num(-d)}` : '0');
  const shortLabel = (label) => String(label).replace(/\s*\(.*\)\s*$/, '');
  // Modules already described by the project and work-item lines.
  const COVERED = new Set(['admin', 'issues', 'rfis', 'submittalsacc', 'forms', 'checklists']);

  function names(list, total) {
    const shown = (list || []).slice(0, 3);
    const more = total - shown.length;
    return shown.join(', ') + (more > 0 ? ` +${num(more)} more` : '');
  }

  function projectLine(p) {
    if (!p) return null;
    const parts = [];
    if (p.added) parts.push(`${num(p.added)} new (${names(p.added_names, p.added)})`);
    if (p.removed) parts.push(`${num(p.removed)} removed (${names(p.removed_names, p.removed)})`);
    if (p.status_changed) {
      const ex = (p.status_examples || [])[0];
      const what = ex ? `${ex.name}: ${ex.from || '—'} → ${ex.to || '—'}` : '';
      parts.push(p.status_changed === 1 ? `1 status change (${what})` : `${num(p.status_changed)} status changes${what ? ` (e.g. ${what})` : ''}`);
    }
    return parts.length ? `Projects: ${parts.join(' · ')}` : null;
  }

  function itemsLine(items) {
    const moved = (items || []).filter((i) => i.new || i.closed);
    if (!moved.length) return null;
    return moved
      .map((i) => `${i.label}: ${[i.new ? `${num(i.new)} new` : '', i.closed ? `${num(i.closed)} closed` : ''].filter(Boolean).join(', ')}`)
      .join(' · ');
  }

  function otherLine(modules) {
    const rest = (modules || []).filter((m) => !COVERED.has(m.module)).slice(0, 4);
    if (!rest.length) return null;
    return `Also changed: ${rest.map((m) => `${shortLabel(m.label)} ${signed(m.after - m.before)}`).join(', ')}`;
  }

  /** The lines to show, most important first. Empty array when there's nothing to compare. */
  function changeLines(c) {
    if (!c) return [];
    const lines = [projectLine(c.projects), itemsLine(c.items), otherLine(c.modules)].filter(Boolean);
    return lines.length ? lines : ['No changes in projects or tracked items.'];
  }

  /** "Compared with the extract of Nov 5, 8:14 PM · +56 rows". Extraction times are UTC. */
  function changeHeading(c) {
    if (!c) return '';
    const ts = c.previous?.extraction_created_at || c.previous?.built_at;
    const d = ts ? new Date(/Z$|[+-]\d\d:?\d\d$/.test(ts) ? ts : `${String(ts).replace(' ', 'T')}Z`) : null;
    const when = d && !Number.isNaN(d.getTime()) ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : c.previous?.as_of || 'the previous one';
    const rows = c.rows?.before != null && c.rows?.after != null ? ` · ${signed(c.rows.after - c.rows.before)} rows` : '';
    return `Compared with the extract of ${when}${rows}`;
  }

  // Items that were in the previous extract but not in this one (deleted, or moved out of view).
  // after = kept + new and before = kept + removed, so removed = before - after + new.
  const removedItems = (i) => Math.max(0, (i.before || 0) - (i.after || 0) + (i.new || 0));

  /** One row per category with movement: { label, added, removed, closed, statusChanged }. */
  function changeTable(c) {
    if (!c) return [];
    const rows = [];
    const p = c.projects;
    if (p && (p.added || p.removed || p.status_changed)) rows.push({ label: 'Projects', added: p.added || 0, removed: p.removed || 0, closed: 0, statusChanged: p.status_changed || 0 });
    for (const i of c.items || []) {
      const removed = removedItems(i);
      if (i.new || i.closed || removed) rows.push({ label: i.label, added: i.new || 0, removed, closed: i.closed || 0, statusChanged: 0 });
    }
    return rows;
  }

  /** "23 added · 2 removed · 4 closed" (zeros left out). '' when there's nothing to compare. */
  function changeTotals(c) {
    if (!c) return '';
    const rows = changeTable(c);
    const sum = (k) => rows.reduce((s, r) => s + (r[k] || 0), 0);
    const parts = [];
    if (sum('added')) parts.push(`${num(sum('added'))} added`);
    if (sum('removed')) parts.push(`${num(sum('removed'))} removed`);
    if (sum('closed')) parts.push(`${num(sum('closed'))} closed`);
    const st = sum('statusChanged');
    if (st) parts.push(`${num(st)} status ${st === 1 ? 'change' : 'changes'}`);
    if (parts.length) return parts.join(' · ');
    return (c.modules || []).some((m) => !COVERED.has(m.module)) ? 'Only other modules changed' : 'No changes';
  }

  /** Extra detail lines under the table: which projects, and the other modules. */
  function changeNotes(c) {
    if (!c) return [];
    const p = c.projects || {};
    return [
      p.added ? `New projects: ${names(p.added_names, p.added)}` : null,
      p.removed ? `Removed projects: ${names(p.removed_names, p.removed)}` : null,
      p.status_changed ? `Status changes: ${(p.status_examples || []).slice(0, 3).map((e) => `${e.name} (${e.from || '—'} → ${e.to || '—'})`).join(', ')}${p.status_changed > 3 ? ` +${num(p.status_changed - 3)} more` : ''}` : null,
      otherLine(c.modules),
    ].filter(Boolean);
  }

  /** One short phrase for a notification, or '' when nothing notable changed. */
  function changeHeadline(c) {
    if (!c) return '';
    return itemsLine(c.items) || projectLine(c.projects) || '';
  }

  const api = { changeLines, changeHeading, changeHeadline, changeTable, changeTotals, changeNotes };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.FormaChanges = api;
})(typeof window !== 'undefined' ? window : globalThis);
