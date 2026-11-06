import { describe, expect, test } from 'bun:test';
import { normalizeValue, kindForSchemaType } from '../src/build/normalize.js';

const n = (v, k) => normalizeValue(v, k).value;

describe('numbers', () => {
  test('zero stays zero (naive loaders using `parseInt(v) || null` turn it into NULL)', () => {
    expect(n('0', 'number')).toBe(0);
    expect(n('0.0', 'number')).toBe(0);
    expect(n('-0.25', 'number')).toBe(-0.25);
  });
  test('integers and decimals', () => {
    expect(n('42', 'number')).toBe(42);
    expect(n('1500000.50', 'number')).toBe(1500000.5);
    expect(n('1e3', 'number')).toBe(1000);
  });
  test('codes are kept as text, flagged as anomalies', () => {
    expect(normalizeValue('007', 'number')).toEqual({ value: '007', anomaly: true });
    expect(normalizeValue('SUB-14-000-0001', 'number')).toEqual({ value: 'SUB-14-000-0001', anomaly: true });
    expect(n('1,234.5', 'number')).toBe('1,234.5');
  });
  test('empty and whitespace become NULL', () => {
    expect(n('', 'number')).toBeNull();
    expect(n('  ', 'text')).toBeNull();
  });
});

describe('booleans', () => {
  test('every encoding Data Connector uses', () => {
    for (const v of ['t', 'true', 'TRUE', '1']) expect(n(v, 'boolean')).toBe(1);
    for (const v of ['f', 'false', 'False', '0']) expect(n(v, 'boolean')).toBe(0);
  });
});

describe('timestamps', () => {
  test('normalized to second precision', () => {
    expect(n('2026-03-28 13:55:08.694', 'datetime')).toBe('2026-03-28 13:55:08');
    expect(n('2017-01-26 18:38:09.780669', 'datetime')).toBe('2017-01-26 18:38:09');
    expect(n('2026-03-03T13:08:25Z', 'datetime')).toBe('2026-03-03 13:08:25');
    expect(n('2019-10-24 00:32:46 UTC', 'datetime')).toBe('2019-10-24 00:32:46');
    expect(n('2022-03-01', 'datetime')).toBe('2022-03-01');
  });
  test('non-UTC offsets are kept verbatim and flagged', () => {
    expect(normalizeValue('2026-01-01 10:00:00+05:00', 'datetime').anomaly).toBe(true);
  });
});

describe('text', () => {
  test('trims tabs and trailing spaces', () => {
    expect(n('\t07924', 'text')).toBe('07924');
    expect(n('Canal / Waterway ', 'text')).toBe('Canal / Waterway');
  });
});

test('schema type mapping', () => {
  expect(kindForSchemaType('number')).toBe('number');
  expect(kindForSchemaType('boolean')).toBe('boolean');
  expect(kindForSchemaType('timestamp: SQL')).toBe('datetime');
  expect(kindForSchemaType('date: string')).toBe('date');
  expect(kindForSchemaType('string: UUID')).toBe('text');
  expect(kindForSchemaType('enum: string')).toBe('text');
});
