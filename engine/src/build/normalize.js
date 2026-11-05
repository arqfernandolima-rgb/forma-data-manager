/**
 * Value normalization for Data Connector CSV cells.
 *
 * Data Connector ships an official schema (schemas/schema.json inside every
 * extract) with a `data_type` per column. We use it instead of guessing types
 * from sample rows. The rules below are deliberately conservative: a value is
 * only converted when the conversion is lossless. Anything unexpected is kept
 * as text and counted as an anomaly, so nothing is silently turned into NULL.
 */

// Storage kinds used for the SQLite table definition (tables are STRICT).
//   'text'    -> TEXT column
//   'number'  -> ANY column (numbers stored as INTEGER/REAL, odd values kept as TEXT)
//   'boolean' -> ANY column (1/0, odd values kept as TEXT)
//   'datetime'-> TEXT column, normalized to 'YYYY-MM-DD HH:MM:SS' (UTC as delivered)
//   'date'    -> TEXT column, 'YYYY-MM-DD'
export function kindForSchemaType(dataType) {
  const t = String(dataType || '').toLowerCase().trim();
  if (t === 'number') return 'number';
  if (t === 'boolean') return 'boolean';
  if (t.startsWith('timestamp')) return 'datetime';
  if (t.startsWith('date')) return 'date';
  return 'text';
}

export function sqlTypeForKind(kind) {
  return kind === 'number' || kind === 'boolean' ? 'ANY' : 'TEXT';
}

// Plain decimal or scientific notation, no thousands separators.
const NUMBER_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
// Leading zeros mean it's a code ("007"), not a quantity. "0", "0.5", "-0.25" are fine.
const LEADING_ZERO_RE = /^[-+]?0\d/;

const TRUE_SET = new Set(['t', 'true', '1', 'y', 'yes']);
const FALSE_SET = new Set(['f', 'false', '0', 'n', 'no']);

// 'YYYY-MM-DD[ T]HH:MM[:SS[.fff…]][Z|±HH:MM]'
const DATETIME_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?(\.\d+)?\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2})?$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Normalize one raw CSV cell.
 * @returns {{ value: any, anomaly: boolean }}
 */
export function normalizeValue(raw, kind) {
  if (raw === undefined || raw === null) return { value: null, anomaly: false };
  // Trim spaces, tabs and stray CR/LF. Data entry often leaves these behind
  // ("Canal / Waterway " vs "Canal / Waterway"), which splits GROUP BY results.
  const v = String(raw).trim();
  if (v === '') return { value: null, anomaly: false };

  switch (kind) {
    case 'number': {
      if (NUMBER_RE.test(v) && !LEADING_ZERO_RE.test(v)) {
        const n = Number(v);
        if (Number.isFinite(n)) {
          // Keep integers that fit safely as integers; zero stays zero.
          return { value: n, anomaly: false };
        }
      }
      return { value: v, anomaly: true };
    }
    case 'boolean': {
      const l = v.toLowerCase();
      if (TRUE_SET.has(l)) return { value: 1, anomaly: false };
      if (FALSE_SET.has(l)) return { value: 0, anomaly: false };
      return { value: v, anomaly: true };
    }
    case 'datetime': {
      if (DATE_RE.test(v)) return { value: v, anomaly: false };
      const m = DATETIME_RE.exec(v);
      if (m) {
        const secs = m[3] || ':00';
        // Offsets other than UTC are rare; keep them visible rather than guessing.
        const tz = m[5];
        if (tz && !/^(z|utc|gmt)$/i.test(tz) && !/^[+-]00:?00$/.test(tz)) return { value: v, anomaly: true };
        return { value: `${m[1]} ${m[2]}${secs}`, anomaly: false };
      }
      return { value: v, anomaly: true };
    }
    case 'date': {
      if (DATE_RE.test(v)) return { value: v, anomaly: false };
      const m = DATETIME_RE.exec(v);
      if (m) return { value: m[1], anomaly: false };
      return { value: v, anomaly: true };
    }
    default:
      return { value: v, anomaly: false };
  }
}

/** Lowercase snake_case identifier safe for SQLite. */
export function safeIdentifier(s) {
  const id = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return id || 'col';
}
