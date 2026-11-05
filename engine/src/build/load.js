/**
 * Streams one CSV from the extract into a STRICT SQLite table.
 * Types come from the official Data Connector schema; see normalize.js.
 */
import Papa from 'papaparse';
import { normalizeValue, sqlTypeForKind, safeIdentifier } from './normalize.js';

const BATCH = 5000;

export async function loadCsv(db, source, entryName, tableName, schemaCols) {
  const stream = await source.stream(entryName);
  if (typeof stream.setEncoding === 'function') stream.setEncoding('utf8');

  let header = null;
  let columns = null; // [{ name, kind, known }]
  let insertMany = null;
  let batch = [];
  let rows = 0;
  let parseErrors = 0;
  const anomalies = new Map(); // column -> { count, example }

  const setup = (rawHeader) => {
    const seen = new Map();
    columns = rawHeader.map((h, i) => {
      let name = safeIdentifier(String(h ?? '').replace(/^﻿/, '') || `col_${i + 1}`);
      const n = (seen.get(name) ?? 0) + 1;
      seen.set(name, n);
      if (n > 1) name = `${name}_${n}`;
      const meta = schemaCols?.get(name);
      return { name, kind: meta?.kind ?? 'text', known: !!meta };
    });
    const defs = columns.map((c) => `"${c.name}" ${sqlTypeForKind(c.kind)}`).join(', ');
    db.exec(`DROP TABLE IF EXISTS "${tableName}"`);
    db.exec(`CREATE TABLE "${tableName}" (${defs}) STRICT`);
    const stmt = db.query(`INSERT INTO "${tableName}" VALUES (${columns.map(() => '?').join(', ')})`);
    insertMany = db.transaction((items) => {
      for (const r of items) stmt.run(...r);
    });
  };

  const flush = () => {
    if (batch.length) {
      insertMany(batch);
      batch = [];
    }
  };

  const handleRow = (fields) => {
    if (!header) {
      header = fields;
      setup(fields);
      return;
    }
    // Skip fully empty trailing lines.
    if (fields.length === 1 && (fields[0] === '' || fields[0] == null)) return;
    if (fields.length !== columns.length) parseErrors++;
    const out = new Array(columns.length);
    for (let i = 0; i < columns.length; i++) {
      const { value, anomaly } = normalizeValue(fields[i], columns[i].kind);
      out[i] = value;
      if (anomaly) {
        const a = anomalies.get(columns[i].name);
        if (a) a.count++;
        else anomalies.set(columns[i].name, { count: 1, example: String(fields[i]).slice(0, 60) });
      }
    }
    batch.push(out);
    rows++;
    if (batch.length >= BATCH) flush();
  };

  await new Promise((resolve, reject) => {
    Papa.parse(stream, {
      header: false,
      skipEmptyLines: false,
      chunk: (results) => {
        try {
          for (const r of results.data) handleRow(r);
          for (const e of results.errors) if (e.type !== 'Delimiter') parseErrors++;
        } catch (err) {
          reject(err);
        }
      },
      complete: () => resolve(),
      error: (err) => reject(err),
    });
  });
  flush();

  if (!columns) return null; // empty file, no header

  return {
    table: tableName,
    rows,
    columns: columns.map((c) => ({ name: c.name, kind: c.kind, known: c.known })),
    unknownColumns: columns.filter((c) => !c.known).map((c) => c.name),
    parseErrors,
    anomalies: Object.fromEntries(anomalies),
  };
}
