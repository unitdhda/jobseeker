import assert from 'node:assert/strict';
import test from 'node:test';
import { migrationDigest, migrationRowDigest, type MigrationColumn } from '../src/lib/migration-verification.ts';

const columns: MigrationColumn[] = [
  { column_name: 'id', data_type: 'bigint' },
  { column_name: 'payload', data_type: 'jsonb' },
  { column_name: 'created_at', data_type: 'timestamp with time zone' },
  { column_name: 'vector', data_type: 'bytea' },
];

test('migration hashes normalize SQLite and PostgreSQL representations', () => {
  const sqlite = { id: 42, payload: '{"z":1,"nested":{"b":2,"a":1}}', created_at: '2026-08-02T12:00:00.000000',
    vector: new Uint8Array([1,2,255]) };
  const postgres = { id: '42', payload: { nested: { a: 1, b: 2 }, z: 1 }, created_at: new Date('2026-08-02T12:00:00Z'),
    vector: Buffer.from([1,2,255]) };
  assert.equal(migrationRowDigest('example',sqlite,columns),migrationRowDigest('example',postgres,columns));
});

test('migration hashes normalize PostgreSQL floating-point text precision', () => {
  const floatColumns: MigrationColumn[] = [{ column_name: 'cosine', data_type: 'double precision' }];
  assert.equal(migrationRowDigest('scores',{ cosine: 0.9253511727314535 },floatColumns),
    migrationRowDigest('scores',{ cosine: 0.925351172731454 },floatColumns));
});

test('migration hashes apply the vacancy published-at repair used during copy', () => {
  const timestamp = '2026-08-02T12:00:00.000Z';
  const timestampColumns: MigrationColumn[] = [
    { column_name: 'published_at', data_type: 'timestamp with time zone' },
    { column_name: 'first_seen_at', data_type: 'timestamp with time zone' },
  ];
  assert.equal(
    migrationRowDigest('vacancy_candidates',{ published_at: '', first_seen_at: timestamp },timestampColumns),
    migrationRowDigest('vacancy_candidates',{ published_at: new Date(timestamp), first_seen_at: new Date(timestamp) },timestampColumns),
  );
});

test('migration aggregate digest is deterministic and detects row changes', () => {
  const left = migrationDigest(['a','b']);
  assert.equal(left,migrationDigest(['a','b']));
  assert.notEqual(left,migrationDigest(['a','c']));
  assert.notEqual(left,migrationDigest(['b','a']));
});
