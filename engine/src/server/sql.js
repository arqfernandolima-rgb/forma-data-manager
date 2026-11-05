/**
 * Prepares model-written SQL for execution. The database is opened read-only with
 * query_only on, so this layer is about clear errors and forgiving input, not security:
 *  - leading/trailing comments and trailing semicolons are removed (models often add them)
 *  - exactly one statement, which must start with SELECT or WITH
 * No LIMIT is injected: the worker stops reading after max_rows + 1 rows, so the
 * caller's own LIMIT, subqueries and CTEs are left untouched.
 */

/** Walk the SQL once, tracking strings/identifiers/comments. Returns code with comments blanked. */
function scan(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  const semis = [];
  while (i < n) {
    const c = sql[i];
    const d = sql[i + 1];
    if (c === '-' && d === '-') {
      const j = sql.indexOf('\n', i);
      const end = j === -1 ? n : j;
      out += ' '.repeat(end - i);
      i = end;
    } else if (c === '/' && d === '*') {
      const j = sql.indexOf('*/', i + 2);
      const end = j === -1 ? n : j + 2;
      out += ' '.repeat(end - i);
      i = end;
    } else if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      let j = i + 1;
      while (j < n) {
        if (sql[j] === close) {
          if (close !== ']' && sql[j + 1] === close) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      const end = Math.min(n, j + 1);
      out += sql.slice(i, end);
      i = end;
    } else {
      if (c === ';') semis.push(out.length);
      out += c;
      i++;
    }
  }
  return { code: out, semis };
}

export function prepareSql(input) {
  const raw = String(input ?? '');
  const { code, semis } = scan(raw);
  // Trailing semicolons (and whitespace) are fine; anything after a semicolon is not.
  const trimmedEnd = code.replace(/[\s;]+$/, '').length;
  if (semis.some((pos) => pos < trimmedEnd)) {
    return { error: 'Only one SQL statement per call. Remove the extra statement after the semicolon.' };
  }
  const start = code.search(/\S/);
  if (start === -1) return { error: 'Empty query.' };
  const sql = raw.slice(start, trimmedEnd).trim();
  const head = code.slice(start, start + 12).toUpperCase();
  if (!/^(SELECT|WITH)\b/.test(head)) {
    return { error: 'Only read-only SELECT or WITH queries are allowed.' };
  }
  if (/\bload_extension\s*\(/i.test(code)) return { error: 'load_extension is not allowed.' };
  return { sql };
}

/** Table/view names referenced after FROM/JOIN (best effort, for error hints). */
export function referencedTables(sql) {
  const names = new Set();
  const re = /\b(?:FROM|JOIN)\s+["`[]?([A-Za-z_][A-Za-z0-9_]*)/gi;
  let m;
  while ((m = re.exec(sql))) names.add(m[1].toLowerCase());
  return [...names];
}

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 4) return 99;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** Rank candidates (optionally "table.column") by how close their last segment is to target. */
export function similar(target, candidates, max = 6) {
  const t = String(target).toLowerCase();
  const parts = t.split(/[_\s.]+/).filter((p) => p.length > 2);
  const scored = candidates
    .map((c) => {
      const full = c.toLowerCase();
      const l = full.split('.').pop();
      let s = 0;
      if (l === t) s += 100;
      const d = editDistance(t, l);
      if (d <= 2) s += 40 - d * 10;
      if (l.includes(t) || t.includes(l)) s += 20;
      for (const p of parts) if (full.includes(p)) s += 5;
      return [c, s];
    })
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1]);
  return scored.slice(0, max).map(([c]) => c);
}
