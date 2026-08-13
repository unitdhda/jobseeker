import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL('../migrations/0.1.12-to-0.2.0.sql', import.meta.url);
const verificationUrl = new URL('../migrations/verify-0.2.0.sql', import.meta.url);

test('0.1.12 migration is clone-only, transactional, preserves legacy schema, and includes fresh schema', async () => {
  const source = await readFile(migrationUrl, 'utf8');
  assert.match(source, /begin;/u); assert.match(source, /commit;/u);
  assert.match(source, /alter schema public rename to legacy_0_1_12/u);
  assert.match(source, /create schema public authorization current_user/u);
  assert.match(source, /\\ir \.\.\/schema\.sql/u);
  assert.doesNotMatch(source, /drop\s+(?:schema|table|column)/iu);
  assert.match(source, /unexpected 0\.1\.12 public table inventory/u);
  assert.match(source, /row count drift/u);
});

test('migration explicitly transforms every lossy legacy representation and preserves delivered memory', async () => {
  const source = await readFile(migrationUrl, 'utf8');
  for (const fragment of [
    "'cvHash',document.cv_sha256,'templateVersion',1,'profile'",
    "jsonb_build_object('from',salary_from,'to',salary_to,'currency',salary_currency",
    "else jsonb_build_object('kind','other','label',experience)",
    "else 'other' end",
    'nullif(normalized_vacancy_id,id)',
    "state in ('alerted','digested','skipped','applying','applied')",
    "case when state='applied' then null else application_status end",
    "coalesce(state->>'token',state->>'_claimToken')",
  ]) assert.ok(source.includes(fragment), fragment);
});

test('verification is read-only and checks counts, profiles, artifacts, duplicate identity, and legacy retention', async () => {
  const source = await readFile(verificationUrl, 'utf8');
  assert.match(source, /begin read only;/u); assert.match(source, /rollback;/u);
  for (const fragment of ['row count mismatch', 'source profile envelope invariant failed', 'artifact cache invariant failed',
    'vacancy self duplicate survived', 'delivered wall invariant failed', 'legacy calibration audit table is missing']) {
    assert.ok(source.includes(fragment), fragment);
  }
});
