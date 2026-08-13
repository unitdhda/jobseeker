# Assignment 02 — PostgreSQL schema and `@jobseeker/store`

## Scope

Build the only runtime persistence layer. It owns a factory-created PostgreSQL pool and named repositories. It receives settings explicitly, never reads environment variables, and exposes raw SQL only under an app-only administrative surface for initialization/integration work.

## Files

```text
packages/app/schema.sql
packages/store/src/client.ts
packages/store/src/repos.ts
packages/store/src/engine-repos.ts
packages/store/src/telegram-repos.ts
packages/store/src/store.ts
packages/store/src/index.ts
```

## 1. Schema of record

Create these tables exactly as a complete fresh schema:

| Table | Primary key | Purpose |
|---|---|---|
| `users` | `user_id` | Telegram identity, access, locale, delivery settings |
| `cv_documents` | `user_id` | authoritative extracted CV and generated profiles |
| `pending_cv_imports` | `user_id` | 15-minute confirmation preview |
| `vacancies` | identity `id` | listing queue, normalized vacancy, dedupe memory |
| `search_units` | `unit_id` | content-addressed discovery work and cadence |
| `unit_subscriptions` | `(unit_id,user_id)` | private user demand attached to shared units |
| `matches` | `(user_id,vacancy_id)` | matching evidence, score, delivery, applications |
| `idf_vocabulary` | `(scope,token)` | derived title/body token weights |
| `idf_corpora` | `scope` | corpus metadata and unknown-token IDF |
| `role_equivalences` | `(token_a,token_b)` | derived cross-language token equivalence |
| `usage_events` | identity `id` | operation and LLM usage accounting |
| `accounts` | `(user_id,day)` | per-user daily cost/counters |
| `user_state` | `(user_id,kind)` | expiring sessions and workflow leases |
| `telegram_updates` | `update_id` | durable webhook update claim state |

### Essential constraints

- user status: `unregistered|pending|approved|rejected|revoked`;
- vacancy lifecycle: `discovered|queued|filtered|normalizing|normalized|duplicate|failed|closed`;
- match state exactly as engine's `MatchState`;
- application status: `generating|ready|failed`;
- apply ID matches six lowercase letters and is globally unique;
- LLM and prescore values are 0–100;
- IDF scope is `title|body`;
- usage kind is `score|application|search-profile|llm`;
- Telegram update state is `processing|completed|failed`;
- all user-owned rows use `ON DELETE CASCADE`;
- do not constrain source/platform IDs to a built-in list.

### Key `matches` fields

Implement columns for:

- lifecycle and timestamps;
- raw lexical score;
- regex score and raw cosine;
- title similarity, skill coverage, seniority gap;
- specificity and IDF cosine;
- prescore score/model/prompt version/time/exploration flag;
- full score/model/time/explanation;
- short alert track/summary/reasons/gaps;
- application state/error/times;
- JSON object of delivered artifacts.

### Indexes

At minimum add indexes for:

- Telegram cleanup;
- usage kind/time and user/kind/time;
- session expiry;
- match user/state and user/score;
- due search units;
- canonical vacancy fingerprints;
- normalization queue;
- generated full-text vacancy vector.

## 2. Store factory and client

Define:

```ts
interface StoreSettings {
  telegramUserId?: string;
  accessRequestCooldownMinutes: number;
  prefilterMaxAgeDays: number;
  searchPlatforms: readonly string[];
  digestMinScore: number;
  alertScore: number;
  timezone: string;
  safeVacancyUrl(source: string, url: string): string;
}
interface StoreOptions {
  databaseUrl: string;
  poolMax: number;
  ssl: pg.PoolConfig['ssl'];
  settings: StoreSettings;
}
```

Use an instance `StoreRuntime` with an optional lazy pool. Bind repository calls to their owner through `AsyncLocalStorage` plus a proxy returned by `createStore`.

Client requirements:

1. no pool creation until first query;
2. bounded pool, connection timeout, keepalive, and idle timeout;
3. retry transient connection failures up to two retries with short exponential delay;
4. bounded/redacted connection errors;
5. transaction helper with rollback and poisoned-client release;
6. transaction-scoped advisory lock helper;
7. session-held singleton lock using a dedicated `pg.Client`, returning a release function or `null`;
8. readiness query and idempotent close.

`createStore` returns repositories, settings, lifecycle methods, advisory-lock helpers, and an `admin` object containing pool/query/transaction access. App runtime modules must not use the admin API.

## 3. User, access, locale, and privacy repositories

Implement `TelegramUser`, `TelegramIdentity`, access request results, and methods to:

- lazily seed the configured owner as approved;
- touch identity without overwriting an explicitly selected locale;
- request access with cooldown after rejection/revocation;
- approve/reject/revoke while owner remains approved;
- list and count users;
- list approved users, optionally requiring a CV;
- require approval;
- set locale;
- save/read delivery settings.

`deleteUserData` must remove matches, pending/authoritative CVs, usage, sessions, and subscriptions; retire orphaned units; clear locale and delivery settings; preserve access identity/status.

`exportUserData` must include CV text/structure, live preview, career and source profiles, scored URLs/scores, and stored delivered artifacts. It must not include generated PDF bytes.

## 4. CV repositories

Define `CvSource` with hash, text, canonical document, format, original filename, media type, parser name/version.

Implement:

- `stageCvSource`: purge expired previews and upsert a TTL-bound extracted document;
- `discardStagedCvSource`;
- `confirmStagedCvSource`: only live preview, save then consume;
- `saveCvSource`: replace authoritative source and clear profiles;
- `getCvSource`, `getCvHash`;
- `saveSearchProfile`, `getSearchProfile`, `clearSearchProfile`.

On a new CV, reset only queued/scored undelivered judgments and prescores. Never reset delivered memory.

## 5. Listing and normalized vacancy lifecycle

### Candidate recording

`recordListingCandidate` must:

- validate URL through injected policy;
- normalize optional source date;
- hash title/summary/url/payload;
- insert shared listing state or refresh an existing row;
- preserve dedupe memory;
- reject a new listing already older than the prefilter age cutoff;
- return true only when globally new.

### Normalized upsert

`upsertVacancy` must:

1. acquire transaction advisory lock by `(source,sourceId)`;
2. validate canonical URL;
3. normalize absent/bad dates safely;
4. create a canonical fingerprint from normalized title/employer;
5. find cross-source duplicates by fingerprint plus description Jaccard threshold;
6. allocate a unique six-letter apply ID under a lock;
7. keep publication date from moving forward on refresh (`least` old/new);
8. update normalized content and content hash;
9. invalidate only undelivered queued/scored rows when content changed;
10. report `{id,needsScore,duplicate}`.

Candidate queue methods must select due `discovered|failed` rows, retry with exponential minute backoff, classify closed rows, and select bounded normalized refreshes.

Retention deletes only old listings no longer seen and with no delivered/application/high-digest match memory.

## 6. Search-unit repositories

Implement:

- `dueUnits(now)` joining approved subscribers;
- `nextUnitDueAt()`;
- `recordUnitRun()` updating cadence/novelty/next run;
- `existingCompiledUnits()`;
- `activeUnitQueries(platform)`;
- `applyDemand(userId,units,subscriptions,initialCadence)`.

`applyDemand` upserts units/subscriptions, removes vanished subscriptions for that user, and retires orphaned units. It must not alter another user's subscription.

## 7. Match repositories and delivered wall

### Ingest

`createMatches` inserts `matched` rows with all frozen lexical evidence using `ON CONFLICT DO NOTHING`. It never updates an existing row.

### Transitions and claims

- `transitionMatch` first validates through engine `assertTransition`, then updates only `WHERE state=from`.
- `claimMatches` atomically changes named `matched` rows to `queued`; returned IDs are the won claims.
- `saveScore` only updates `queued` rows.
- `savePrescore` only updates `queued` rows without full scores and returns them to `matched` with the new semantic data.
- failed/rescored rows wait six hours when `updated_at > matched_at`, preventing head-of-queue starvation.
- `expireStaleMatches` touches only unscored `matched` rows, never active claims.

### Pending types

Define `PendingMatch` with vacancy/time/source/publication and all lexical/prescore fields. `pendingMatchesForScoring` must support required model/version/minimum and exploration admission. `pendingMatchesForPrescoring` returns stale/missing prescores.

### Budget and derived vocabularies

- `addSpend` upserts per-user/day USD and one named counter.
- `spentToday` returns USD.
- replace role equivalences transactionally.
- replace IDF scope transactionally in chunks through `unnest`.
- stream vacancy corpus in ID-ordered batches.

## 8. Scored reads, delivery, and applications

Implement:

- scored lookup by numeric ID and full apply ID;
- full-text scored-vacancy search;
- unambiguous prefix lookup returning at most two rows;
- digest-range reads;
- addressable digest: current delivered snapshot plus newly queued rows;
- paged addressable digest with all apply IDs;
- atomic snapshot replacement and `last_digest_at` update;
- unsent high-score alert reads;
- `markAlerted` clearing only short alert fields, while full explanation survives;
- skip, begin application, ready, failure, delivered state;
- per-artifact cache `{cvSha256,fileId?|text?,deliveredAt}`;
- application usage recorded on delivery, distinguished by agent (`tailor-application`, `tailor-cover-letter`).

All state-changing queries require source-state predicates where races are possible.

## 9. Sessions and durable webhook updates

Validate session kind as lowercase alphanumeric/hyphen and TTL as 1 second–30 days.

Implement get/set/delete plus token-owned claim/update/release. Claim uses upsert only when absent/expired and retries a release race.

Webhook update claims:

- insert a five-minute processing lease;
- optionally reclaim failed/expired processing rows;
- mark complete or failed with error class only;
- hourly opportunistic cleanup after seven days;
- validate non-negative safe integer update IDs.

## 10. Operational summaries

Implement usage summaries and `scraperSummary` with exactly 25 hourly buckets, source rows (including zero-activity configured sources), unit cadence/overdue status, matched/scored counts, and three bounded parser-error summaries.

## Acceptance tests

### Unit

`packages/store/tests/factory.test.ts` must prove independent settings and lazy pools.

### PostgreSQL integration

`packages/app/tests/database-postgres.integration.ts` must prove:

- no legacy tables;
- expected schema columns/types;
- access lifecycle;
- sessions and one-winner workflow leases;
- staged CV does not replace authoritative CV until confirmation;
- old listings are refused while fresh ones are accepted;
- vacancy/match/prescore/full-score lifecycle;
- duplicate claim loses cleanly;
- score explanation persists;
- cached artifacts export;
- personal deletion preserves access identity;
- singleton lock excludes a second session and can be reacquired after release.

Run against a disposable or explicitly approved test database:

```bash
bun run test:postgres
```
