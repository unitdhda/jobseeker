import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (name: string): Promise<string> => readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');

test('store domain receives settings explicitly and never reads environment variables', async () => {
  const source = (await Promise.all(['client.ts', 'store.ts', 'repos.ts', 'engine-repos.ts', 'telegram-repos.ts'].map(read))).join('\n');
  assert.doesNotMatch(source, /\bprocess\s*\.\s*env\b|\bBun\s*\.\s*env\b/u);
});

test('match claims and transitions retain source-state predicates and delivered wall', async () => {
  const engine = await read('engine-repos.ts');
  const repos = await read('repos.ts');
  assert.match(engine, /where user_id=\$1 and vacancy_id=any\(\$2::bigint\[\]\) and state='matched' returning vacancy_id/u);
  assert.match(engine, /where user_id=\$1 and vacancy_id=\$2 and state=\$3/u);
  assert.match(repos, /state in \('matched','queued','scored'\) and delivered_at is null/u);
  assert.match(repos, /Full score_explanation survives delivery/u);
  assert.match(repos, /application_artifacts=jsonb_set/u);
  assert.doesNotMatch(repos, /application_artifacts[^\n]*(?:bytea|Buffer)/iu);
});

test('normalization claims are source-fair, lease-bounded, and reclaim expired work', async () => {
  const repos = await read('repos.ts');
  const claim = /export async function queuedListings[\s\S]*?\n\}/u.exec(repos)?.[0] ?? '';
  assert.match(claim, /row_number\(\) over\(partition by source order by next_normalization_at,id\)/u);
  assert.match(claim, /lifecycle_status in \('discovered','failed','normalizing'\)/u);
  assert.match(claim, /r\.source_rank<=\$2/u);
  assert.match(claim, /for update of v skip locked limit \$1/u);
  assert.match(claim, /next_normalization_at=now\(\)\+make_interval\(mins=>\$2::integer\)/u);
  assert.match(claim, /normalization_attempts=normalization_attempts\+1/u);
  const failure = /export async function markCandidateFailed[\s\S]*?\n\}/u.exec(repos)?.[0] ?? '';
  assert.match(failure, /least\(1440,power\(2,greatest\(0,normalization_attempts-1\)\)\)/u);
});

test('candidate selection excludes stored rows the decoder cannot accept and counts them', async () => {
  const repos = await read('repos.ts');
  assert.match(repos, /const decodableCandidate = `listing_hash ~ '\^\[0-9a-f\]\{64\}\$'/u);
  for (const name of ['queuedListings', 'candidatesDueForRefresh']) {
    const source = new RegExp(`export async function ${name}[\\s\\S]*?\\n\\}`, 'u').exec(repos)?.[0] ?? '';
    assert.match(source, /\$\{decodableCandidate\}/u);
  }
  const summary = /export async function scraperSummary[\s\S]*?\n\}/u.exec(repos)?.[0] ?? '';
  // A null column makes the predicate unknown, so counting must use `is not true` rather than negation.
  assert.match(summary, /\(\$\{decodableCandidate\}\) is not true\) undecodable/u);
});

test('every parameterized interval carries an explicit type', async () => {
  const sources = await Promise.all(['repos.ts', 'engine-repos.ts', 'telegram-repos.ts'].map(read));
  // An untyped $n used both as an integer column value and an interval multiplier is rejected with 42P08 at runtime.
  for (const source of sources) assert.doesNotMatch(source, /\$\d+\s*\*\s*interval/u);
  const engine = sources[1]!;
  const record = /export async function recordUnitRun[\s\S]*?\n\}/u.exec(engine)?.[0] ?? '';
  assert.match(record, /cadence_minutes=\$2::integer/u);
  assert.match(record, /next_run_at=\$3::timestamptz\+make_interval\(mins=>\$2::integer\)/u);
  const expiry = /export async function expireStaleMatches[\s\S]*?\n\}/u.exec(engine)?.[0] ?? '';
  assert.match(expiry, /\$2::timestamptz-make_interval\(days=>\$1::integer\)/u);
});

test('engine scheduling, refresh, vocabularies, and applications retain their ownership predicates', async () => {
  const engine = await read('engine-repos.ts');
  const repos = await read('repos.ts');
  assert.match(engine, /u\.platform=any\(\$2::text\[\]\)/u);
  assert.match(engine, /export async function replaceMatchingVocabularies[\s\S]*?withPostgresTransaction/u);
  assert.match(repos, /export async function markCandidateRefreshFailed[\s\S]*?lifecycle_status='normalized'/u);
  assert.match(repos, /export async function beginApplication[\s\S]*?artifact: ApplicationArtifact[\s\S]*?cvSha256/u);
  assert.match(repos, /state in \('alerted','digested','skipped','applied'\)/u);
  assert.match(repos, /application_artifacts->\$3->>'cvSha256' is distinct from \$4/u);
});

test('CV confirmation locks a live preview, saves, then consumes it', async () => {
  const repos = await read('repos.ts');
  const confirmation = /export async function confirmStagedCvSource[\s\S]*?\n\}\n/u.exec(repos)?.[0] ?? '';
  assert.match(confirmation, /expires_at>now\(\) for update/u);
  assert.ok(confirmation.indexOf('saveCvWithClient') < confirmation.indexOf("delete from pending_cv_imports"));
});

test('personal deletion preserves access identity while removing user-owned data', async () => {
  const repos = await read('repos.ts');
  const deletion = /export async function deleteUserData[\s\S]*?\n\}\n/u.exec(repos)?.[0] ?? '';
  assert.doesNotMatch(deletion, /delete from users/u);
  for (const table of ['matches', 'pending_cv_imports', 'cv_documents', 'usage_events', 'accounts', 'user_state']) {
    assert.match(deletion, new RegExp(`'${table}'`, 'u'));
  }
  assert.match(deletion, /delete from unit_subscriptions/u);
});

test('session and webhook claims use token/state/lease predicates', async () => {
  const source = await read('telegram-repos.ts');
  assert.match(source, /where user_state\.expires_at<=now\(\)/u);
  assert.match(source, /where user_id=\$1 and kind=\$2 and token=\$3 and expires_at>now\(\)/u);
  assert.match(source, /state='failed' or \(state='processing' and lease_expires_at<=now\(\)\)/u);
  assert.match(source, /where update_id=\$1 and state='processing'/u);
});

test('match-history search is bounded to one user and includes rows without a full score', async () => {
  const repos = await read('repos.ts');
  const search = /export async function searchMatchedVacancies[\s\S]*?\n\}\n/u.exec(repos)?.[0] ?? '';
  assert.match(search, /where m\.user_id=\$1 and v\.search_vector@@search\.query/u);
  assert.match(search, /m\.llm_score desc nulls last/u);
  assert.doesNotMatch(search, /m\.llm_score is not null/u);
  assert.match(search, /limit \$3/u);
});

test('match-code reads are scored-only, user-scoped, ordered, and ambiguity-bounded', async () => {
  const repos = await read('repos.ts');
  const snapshot = /export async function scoredVacancyApplyIds[\s\S]*?\n\}\n/u.exec(repos)?.[0] ?? '';
  const prefix = /export async function scoredVacanciesByApplyIdPrefix[\s\S]*?\n\}\n/u.exec(repos)?.[0] ?? '';
  for (const source of [snapshot, prefix]) {
    assert.match(source, /m\.user_id=\$1/u); assert.match(source, /m\.llm_score is not null/u);
  }
  assert.match(snapshot, /order by v\.apply_id/u);
  assert.match(prefix, /v\.apply_id like \$2\|\|'%'/u); assert.match(prefix, /limit 2/u);
});

test('LLM usage writes every durable token class and rejects invalid counters', async () => {
  const repos = await read('repos.ts');
  const recording = /export async function recordLlmUsageEvent[\s\S]*?\n\}\n/u.exec(repos)?.[0] ?? '';
  for (const column of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'total_tokens', 'cost_usd']) {
    assert.match(recording, new RegExp(`\\b${column}\\b`, 'u'));
  }
  assert.match(recording, /Number\.isSafeInteger/u); assert.match(recording, /Number\.isFinite/u);
});

test('operational summaries contain exactly the current hour plus previous 24 hours', async () => {
  const repos = await read('repos.ts');
  const series = /generate_series\(date_trunc\('hour',now\(\)\)-interval '24 hours',date_trunc\('hour',now\(\)\),interval '1 hour'\)/gu;
  assert.equal([...repos.matchAll(series)].length, 2);
  const summary = /export async function scraperSummary[\s\S]*?\n\}/u.exec(repos)?.[0] ?? '';
  assert.match(summary, /lifecycle_status in \('discovered','failed'\).*queued/su);
  assert.match(summary, /lifecycle_status='normalizing' and next_normalization_at>now\(\).*active_claims/su);
  assert.match(summary, /lifecycle_status='normalizing' and next_normalization_at<=now\(\).*expired_claims/su);
});
