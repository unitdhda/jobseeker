import { createHash } from 'node:crypto';

export interface MigrationColumn {
  column_name: string;
  data_type: string;
}

export function migrationParameterValue(value: unknown, table: string, column: string, dataType: string,
  record: Record<string, unknown>): unknown {
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (dataType === 'timestamp with time zone' && value === '') {
    if (table === 'vacancy_candidates' && column === 'published_at') return record.first_seen_at;
    return null;
  }
  return value === undefined ? null : value;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stableValue(item)]));
  return value;
}

function canonicalValue(value: unknown, dataType: string): unknown {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `hex:${Buffer.from(value).toString('hex')}`;
  if (dataType === 'json' || dataType === 'jsonb') {
    const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
    return stableValue(parsed);
  }
  if (dataType.includes('timestamp')) {
    const raw = String(value);
    const hasZone = /(?:z|[+-]\d{2}(?::?\d{2})?)$/i.test(raw);
    const unzonedDateTime = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(raw) && !hasZone;
    const timestamp = value instanceof Date ? value : new Date(unzonedDateTime ? `${raw}Z` : raw);
    if (!Number.isNaN(timestamp.getTime())) return timestamp.toISOString();
  }
  if (dataType === 'date') {
    const date = value instanceof Date ? value : new Date(String(value));
    if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  }
  if (dataType === 'boolean') return typeof value === 'string' ? value === 'true' || value === '1' : Boolean(value);
  if (['smallint','integer','bigint','numeric','decimal'].includes(dataType)) return String(value);
  if (['real','double precision'].includes(dataType)) return Number(value).toPrecision(15);
  return value;
}

export function migrationRowDigest(table: string, record: Record<string, unknown>, columns: MigrationColumn[]): string {
  const canonical = columns.map(({ column_name: column, data_type: dataType }) => [column,
    canonicalValue(migrationParameterValue(record[column],table,column,dataType,record),dataType)]);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function migrationDigest(rowDigests: string[]): string {
  return createHash('sha256').update(rowDigests.join('\n')).digest('hex');
}
