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

  /** One short phrase for a notification, or '' when nothing notable changed. */
  function changeHeadline(c) {
    if (!c) return '';
    return itemsLine(c.items) || projectLine(c.projects) || '';
  }

  const api = { changeLines, changeHeading, changeHeadline };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.FormaChanges = api;
})(typeof window !== 'undefined' ? window : globalThis);
