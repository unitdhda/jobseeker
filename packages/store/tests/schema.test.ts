import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const schemaPath = resolve(fileURLToPath(new URL('../../app/schema.sql', import.meta.url)));
const requiredTables = [
  'users', 'cv_documents', 'pending_cv_imports', 'vacancies', 'search_units', 'unit_subscriptions',
  'matches', 'idf_vocabulary', 'idf_corpora', 'role_equivalences', 'usage_events', 'accounts',
  'user_state', 'telegram_updates',
] as const;

test('schema is one complete fresh definition with exactly the required tables', async () => {
  const sql = await readFile(schemaPath, 'utf8');
  const tables = [...sql.matchAll(/\bcreate\s+table\s+([a-z_]+)/giu)].map((match) => match[1]);
  assert.deepEqual(tables.sort(), [...requiredTables].sort());
  assert.doesNotMatch(sql, /\balter\s+table\b|\bdrop\s+table\b|\bcreate\s+table\s+if\s+not\s+exists\b/iu);
});

test('schema freezes lifecycle vocabularies and source-independent identities', async () => {
  const sql = await readFile(schemaPath, 'utf8');
  for (const state of ['unregistered', 'pending', 'approved', 'rejected', 'revoked']) assert.match(sql, new RegExp(`'${state}'`, 'u'));
  for (const state of ['discovered', 'queued', 'filtered', 'normalizing', 'normalized', 'duplicate', 'failed', 'closed']) assert.match(sql, new RegExp(`'${state}'`, 'u'));
  for (const state of ['matched', 'queued', 'scored', 'alerted', 'digested', 'skipped', 'applying', 'applied', 'expired']) assert.match(sql, new RegExp(`'${state}'`, 'u'));
  assert.match(sql, /unique\s*\(source,\s*source_id\)/iu);
  assert.match(sql, /apply_id\s+text\s+unique\s+check\s*\(apply_id is null or apply_id ~ '\^\[a-z\]\{6\}\$'/iu);
  assert.doesNotMatch(sql, /source\s+[^,]*\bin\s*\(/iu);
});

test('usage accounting durably retains every token class with wide counters and precise costs', async () => {
  const sql = await readFile(schemaPath, 'utf8');
  const usage = /create table usage_events \(([\s\S]*?)\n\);/iu.exec(sql)?.[1] ?? '';
  for (const column of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'total_tokens']) {
    assert.match(usage, new RegExp(`${column}\\s+bigint\\s+not null\\s+default 0`, 'iu'));
  }
  assert.match(usage, /cost_usd\s+numeric\(14,8\)/iu);
  assert.match(sql, /spent_usd\s+numeric\(14,8\)/iu);
});

test('every user-owned table cascades and privacy-sensitive artifacts remain JSON metadata', async () => {
  const sql = await readFile(schemaPath, 'utf8');
  for (const table of ['cv_documents', 'pending_cv_imports', 'unit_subscriptions', 'matches', 'usage_events', 'accounts', 'user_state']) {
    const block = new RegExp(`create table ${table} \\(([\\s\\S]*?)\\n\\);`, 'iu').exec(sql)?.[1] ?? '';
    assert.match(block, /references\s+users\s*\(user_id\)\s+on\s+delete\s+cascade/iu, `${table} must cascade`);
  }
  assert.match(sql, /application_artifacts\s+jsonb/iu);
  assert.doesNotMatch(sql, /(?:pdf|artifact)_bytes\s+(?:bytea|blob)/iu);
});

test('match diagnostics, queue indexes, and generated search vector are present', async () => {
  const sql = await readFile(schemaPath, 'utf8');
  for (const column of [
    'lexical_score', 'regex_score', 'lexical_cosine', 'title_similarity', 'skill_coverage', 'seniority_gap',
    'specificity', 'lexical_cosine_idf', 'prescore_score', 'score_explanation', 'application_artifacts',
  ]) assert.match(sql, new RegExp(`\\b${column}\\b`, 'u'));
  for (const index of [
    'telegram_updates_cleanup_idx', 'usage_events_kind_time_idx', 'usage_events_user_kind_time_idx',
    'user_state_expiry_idx', 'matches_user_state_idx', 'matches_user_score_idx', 'search_units_due_idx',
    'vacancies_canonical_fingerprint_idx', 'vacancies_normalization_queue_idx', 'vacancies_search_vector_idx',
  ]) assert.match(sql, new RegExp(`create index ${index}\\b`, 'iu'));
  assert.match(sql, /search_vector\s+tsvector\s+generated\s+always\s+as/iu);
});
