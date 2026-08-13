# Assignment 05 — application composition, AI, workflows, workers, and Telegram

## Scope

Build `packages/app`, the executable and published package. It is the only layer allowed to parse environment variables, compose all workspaces, select models, connect Telegram, and coordinate cross-domain workflows.

## 1. Configuration

Implement strict parsers for integer, fraction, boolean, locale, model ID, thinking level, Telegram mode, and platform list.

The configuration object must cover:

- generation/scoring/prescoring/fallback models and thinking levels;
- source page/query/new-listing limits;
- clustering threshold, retention, normalization/refresh concurrency;
- prefilter threshold/max age;
- prescore threshold/batch/cycle/exploration/version;
- scoring workers, batch size, timeout, attempts, per-cycle count;
- per-user LLM USD/day;
- search unit cadence floor/ceiling;
- artifact and search-profile limits;
- workflow/delivery/worker bounds;
- access/CV cooldowns;
- alert/digest thresholds;
- timezone/default locale/owner;
- engine and Telegram ownership mode.

Cross-field validation:

- digest threshold below alert threshold;
- cover-letter limit not below tailored-CV limit;
- min score concurrency not above max;
- missing models remain undefined and fail only when that role is invoked;
- empty `SEARCH_PLATFORMS` means all registered providers.

## 2. Composition order

1. Load extensions.
2. Validate unique source provider IDs and requested discovery IDs.
3. Derive trusted URL policy.
4. Create one store with URL guard and settings.
5. Create one source collection using store's listing sink.
6. Register every extension provider.
7. Compose AI catalogue from all built-ins plus extension providers.
8. Start Telegram, worker, and engine according to ownership config.

Store composition must be imported before repositories are used.

## 3. Encrypted runtime state and AI credentials

### Runtime state

Use AES-256-GCM with:

- 32-byte hex key;
- random 12-byte IV;
- object path as AAD;
- binary envelope magic/version, while retaining compatibility with a JSON envelope;
- safe path namespace restricted to `oauth|browser|healthcheck`;
- Supabase-compatible object REST route;
- bearer/api-key headers;
- bounded request timeouts.

`runtimeStateConfigured` is true only when URL, key, bucket, and encryption key are all present.

### Credential store

Implement Pi-AI `CredentialStore` over either encrypted object `oauth/codex.json` or atomic mode-0600 local JSON.

- provider-keyed auth.json shape;
- serialized in-process operation chain;
- whole-document PostgreSQL advisory lock;
- OAuth refresh read-modify-write cannot race another provider/process;
- stored credential wins over environment credentials;
- never print credential values.

### Models and JSON generation

Register the complete built-in Pi-AI provider catalogue plus extension providers. Resolve `provider/model` IDs only at request time.

`generateJson` must:

1. require configured/registered model;
2. call `completeSimple` with system and user prompt;
3. request configured reasoning and retry transport failures through Pi-AI;
4. record every response's token classes and cost;
5. extract raw/fenced/embedded JSON;
6. validate with Valibot;
7. retry invalid JSON up to three total attempts with bounded, value-specific validation feedback;
8. optionally run deterministic repair only after model retries fail;
9. reject error/aborted responses.

Maintain in-process total/by-agent/by-model usage snapshots in addition to durable events.

## 4. Career and search profiles

Career generation uses an occupation-neutral strict profile contract. The prompt must state every schema cap, separate translated title variants, forbid adjacent occupations/invented skills, and identify CV evidence.

Per source:

1. read provider template and schema;
2. include career profile and authoritative CV;
3. include at most 30 unattributed existing search wordings as advisory reuse candidates;
4. allow empty searches when a constrained source has no supported category;
5. record usage before generation;
6. verify CV hash before and after generation;
7. validate saved profile;
8. isolate one platform's generation failure.

Then compile user demand, apply subscriptions, refresh role equivalences, and backfill recent normalized stock through the new lens.

`missingSearchProfiles` reports stale/missing career and provider profiles.

## 5. Live matching vocabularies

Maintain two app-owned in-memory states:

- role-equivalence resolver loaded from/rebuilt into PostgreSQL;
- title/body IDF lookups loaded from/rebuilt into PostgreSQL.

Rebuild daily from current profiles and vacancy corpus. Failed rebuild keeps prior state. Startup loads persisted state but does not perform expensive rebuild.

## 6. Semantic prescoring

Optional when `AI_PRESCORING_MODEL` is set.

- Claim stale/unscored rows up to cycle cap.
- Load authoritative CV and bounded vacancy text.
- Score in batches with exact one-result-per-vacancy validation.
- Conservative v2 rubric: profession/responsibility first, explicit skills, seniority both directions, explicit blockers.
- Score 40 is default production threshold.
- Freeze exploration once with configured probability only below threshold.
- Save model/version/time and return row to matched queue.
- On batch failure return every claim to matched.

Semantic score owns full-score admission and ordering. Deterministic evidence only bounds mini-model traffic.

## 7. Full scoring

### Contract

Define six integer dimensions:

- skills 0–40;
- seniority 0–20;
- responsibilities 0–15;
- domain 0–10;
- location/work format 0–10;
- compensation 0–5.

Each verdict includes:

- vacancy ID and 0–100 total;
- dimensions summing exactly to total;
- up to five requirements with importance, supported/adjacent/gap/unclear, exact vacancy evidence, and exact/null CV evidence;
- up to three explicit blockers;
- primary track, summary, reasons, gaps;
- hard rejection flag.

Validation rules:

- hard rejection caps score at 49 and requires blocker evidence;
- blockers forbidden without hard rejection;
- one exact result per requested vacancy.

### Runtime

- prescore first;
- rank and claim best rows;
- divide into batches;
- run through adaptive global score pool;
- record one score usage event per attempted vacancy;
- bound each attempt by abort timeout;
- retry up to configured attempts;
- detect subscription terminal usage limit and temporarily switch to optional fallback model;
- save durable explanation and short alert fields;
- if a final response error occurred after writes, detect already-saved scores;
- return failed claims to matched; repository cooldown prevents immediate monopolization.

Engine accounting records actual LLM cost delta into the user's daily account.

## 8. Application generation

Treat CV and letter as independent artifacts and independent daily limits.

### Tailored CV

- begin application state;
- provide canonical CV document/text plus vacancy and language;
- classify requirements internally;
- preserve employers, chronology, dates, metrics, contacts, skills, education, and languages;
- tailor by selection/order/truthful emphasis only;
- strict structured block contract with all caps in prompt;
- repair model drift only after retries;
- accept prose fallback and parse it;
- run deterministic evidence gate;
- render with bundled fonts;
- return PDF bytes only across worker IPC.

### Cover letter

- separate model call and schema;
- 80–2,000 characters;
- at most three short plain-text paragraphs and target under 1,500 characters;
- no Markdown, headings, bullets, salutation/signature block;
- vacancy language and concrete CV evidence only.

On success mark ready; delivery marks applied and records usage. On failure persist failure and return to an alert-delivered state.

Before generation, Telegram checks cached artifact against current CV hash. Same hash resends `file_id` or text without model call/limit use. New hash regenerates.

## 9. Worker architecture

### General job worker

A persistent child process handles:

```ts
type JobPayload =
  | {type:'refresh-user';userId:string;cvHash:string}
  | {type:'tailor-application';userId:string;vacancyId:number;artifact:'cv'|'letter'};
```

Requirements:

- spawned with Telegram off and jobs off;
- ready handshake;
- numeric request IDs and pending map;
- maximum pending queue;
- one `KeyedTaskScheduler` serializes each user while allowing bounded users;
- reject stale CV hash;
- enforce profile/artifact limits;
- serialize PDF as base64 over IPC;
- reject all requests if child exits;
- graceful disconnect then 3-second force kill.

CV extraction uses the separate stricter parser worker specified in [04-cv.md](04-cv.md).

## 10. Engine composition

Compose ports from store, source registry, matching, workflows, and delivery.

Discovery lane:

- scheduler tick with bounded platform concurrency;
- normalization limit scales by users;
- load approved lenses once per match pass;
- match every newly normalized vacancy.

Judgment lane:

- per-user paced scoring;
- alerts and digests;
- hourly stale-match retirement;
- daily equivalence/IDF maintenance.

Before starting lanes, acquire `jobseeker-engine-loop`; if unavailable, log and idle. Load matching vocabularies and run extension startup hooks only for the lock holder. Shutdown closes sources, hooks, and lock.

## 11. Telegram architecture

Files/layers:

```text
telegram/api.ts           bot singleton, identity, send error helpers
telegram/format.ts        pure HTML/rich formatting and charts
telegram/delivery.ts      alerts and digests
telegram/indicators.ts    editable progress messages
telegram/workflow-lock.ts durable per-user expensive-work lease
telegram/actions.ts       file/application/profile orchestration
telegram/bot.ts           middleware, commands, callbacks
```

### Access and locale middleware

- private chats only;
- unknown arbitrary senders do not create rows;
- `/start`, `/request`, `/language` are always allowed;
- touch identity and resolve locale once per update;
- explicit stored locale wins; otherwise client language then deployment default;
- all user-facing strings come from a typed RU/EN catalogue;
- command menu follows chat locale.

### Commands

Implement:

- public: `/start`, `/request`, `/language`;
- approved: `/cv`, `/window`, `/digest`, `/search`, `/privacy`, `/export_me`, `/delete_me`;
- owner: `/ok`, `/users`, `/revoke`, `/usage`, `/scraper`, `/status`.

### CV flow

1. `/cv` checks active workflow and cooldown, arms upload session.
2. Document validates size/type, acquires workflow lease, shows indicator, downloads bounded file, isolates extraction.
3. Show escaped preview/warnings and confirm/reject buttons.
4. Confirm consumes preview and hands lease to profile refresh.
5. Reject/retry rearms upload without replacing authoritative CV.

### Durable workflow lease

One lease across CV import, profile refresh, tailored CV, and letter:

```ts
interface UserWorkflowState {
  token:string;
  kind:'cv-import'|'profile-refresh'|'tailored-cv'|'cover-letter';
  startedAt:string;
}
```

TTL 30 minutes, renew every 5 minutes, token-owned update/release. A loser gets an explicit non-queued busy message; repeated clicks do not start more model calls.

### Delivery

High alert:

- only approved user;
- score, apply ID, source, track/salary, summary, up to three reasons/two gaps;
- CV, letter, skip, source-link buttons;
- mark alerted only after send;
- pace sequential sends and defer on Telegram 429.

Digest:

- scores in `[DIGEST_MIN_SCORE, ALERT_SCORE)` since last scheduled digest;
- one HTML message, 10 items/page;
- navigation edits same message;
- apply ID bolds shortest prefix unique over whole digest;
- on-demand digest does not consume queue;
- scheduled digest atomically replaces snapshot and advances time;
- old snapshot IDs remain addressable until replaced.

### Owner observability

- usage totals and fixed 25-point dual-axis chart;
- scraper totals, every configured source including zero rows, units, errors, chart;
- split messages under Telegram limit on line boundaries;
- status with process memory/CPU/uptime, worker queue, AI concurrency, Telegram mode, engine lanes;
- transient repeated command output is deleted/tracked for under 48 hours.

## 12. Localization and formatting tests

Catalogue type is derived from Russian; English must match every key/function arity and contain no Cyrillic. User-controlled strings and URLs must be HTML-escaped. Number, salary, time, and status formatting use the reader's locale.

## Acceptance test groups

- AI/contracts: `career-profile-repair`, `profile-prompt`, `scoring-contract`, `prescoring`, `application-schema`.
- Matching: `prefilter`.
- Concurrency: `concurrency`, `workflow-spam`.
- Extensions/state/security: `extensions`, `encrypted-state-store`, `security`.
- Telegram presentation: `i18n`, `digest-page`, `search-profile-message`, `usage-chart`, `scraper-status`.
- Optional live benchmark is never part of normal tests.

Run:

```bash
bun run typecheck
bun run test
bun run build
```
