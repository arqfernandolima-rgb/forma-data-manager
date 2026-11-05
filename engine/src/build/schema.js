/**
 * Reads the official Data Connector schema that ships inside every extract.
 *
 * Layout (as delivered by Data Connector):
 *   schemas/schema.json        -> { <service>: { <table>: { <column>: { data_type, notes, ordinal_position } } } }
 *   schemas/<service>.json     -> { <table>: { <column>: {...} } }   (same content, split per service)
 * CSV files are named <service>_<table>.csv, so the flattened key matches the CSV name.
 * Entries that are not column maps (e.g. activity verb details, the change log) are ignored.
 */
import { kindForSchemaType, safeIdentifier } from './normalize.js';

function isColumnMap(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const vals = Object.values(obj);
  return vals.length > 0 && vals.every((m) => m && typeof m === 'object' && 'data_type' in m);
}

function addService(out, service, tables) {
  if (!tables || typeof tables !== 'object') return;
  for (const [table, cols] of Object.entries(tables)) {
    if (!isColumnMap(cols)) continue;
    const key = safeIdentifier(`${service}_${table}`);
    const map = new Map();
    for (const [col, meta] of Object.entries(cols)) {
      map.set(safeIdentifier(col), {
        sourceType: String(meta.data_type ?? ''),
        kind: kindForSchemaType(meta.data_type),
        description: typeof meta.notes === 'string' ? meta.notes.trim() : '',
        ordinal: Number(meta.ordinal_position) || null,
      });
    }
    out.set(key, map);
  }
}

/** @returns {Promise<Map<string, Map<string, {sourceType, kind, description, ordinal}>>>} */
export async function loadSchema(source) {
  const out = new Map();
  const names = source.list().map((f) => f.name);
  const combined = names.find((n) => /(^|\/)schemas\/schema\.json$/i.test(n));
  if (combined) {
    try {
      const doc = JSON.parse(await source.readText(combined));
      for (const [service, tables] of Object.entries(doc)) addService(out, service, tables);
    } catch (e) {
      // Fall through to per-service files.
    }
  }
  if (out.size === 0) {
    for (const n of names.filter((x) => /(^|\/)schemas\/[^/]+\.json$/i.test(x))) {
      const service = n.split('/').pop().replace(/\.json$/i, '');
      if (service === 'schema' || service === 'changes') continue;
      try {
        addService(out, service, JSON.parse(await source.readText(n)));
      } catch {
        /* ignore unreadable schema files */
      }
    }
  }
  return out;
}
