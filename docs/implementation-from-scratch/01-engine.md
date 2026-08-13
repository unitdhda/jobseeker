# Assignment 01 — `@jobseeker/engine`

## Scope

Build a deterministic, storage-free, network-free policy package. Every side effect enters through a typed port. The package must not read environment variables or import app, store, sources, or CV.

## File listing

```text
packages/engine/src/
├── contracts.ts
├── canon.ts
├── identity.ts
├── subscribe.ts
├── cadence.ts
├── pick.ts
├── match-state.ts
├── prefilter.ts
├── idf.ts
├── equivalence.ts
├── concurrency.ts
├── runtime.ts
├── loop.ts
└── index.ts
```

## 1. Pipeline contracts

In `contracts.ts`, define:

```ts
interface SearchRecipient { userId: string; searchName: string }
interface PlannedSearch<T> { search: T; recipients: SearchRecipient[] }
interface SearchPlan<T> { searches: PlannedSearch<T>[] }

interface VacancyContent {
  source: string; sourceId: string; name: string; employer: string; area: string;
  salaryFrom: number | null; salaryTo: number | null; salaryCurrency: string | null;
  salaryGross: boolean | null; experience: string; employment: string; schedule: string;
  workFormat: string; description: string; keySkills: string[]; url: string;
  publishedAt: string; sourceQuery: string; contentHash: string;
}
interface VacancyInput extends VacancyContent {}
interface VacancyCandidateInput {
  source: string; sourceId: string; url: string; searchName: string; title: string;
  summary?: string; publishedAt?: string; payload?: unknown;
}
interface VacancyCandidate extends Omit<VacancyCandidateInput, 'summary' | 'publishedAt'> {
  summary: string; publishedAt: string; listingHash: string; status: string;
  attempts: number; combinedScore: number | null;
}
```

These types are the shared language among engine, store, and sources.

## 2. Canonical role tokens

Implement:

- `canonicalRoleToken(token): string`;
- `searchTokens(text): Set<string>`.

Requirements:

1. NFKC-normalize and lowercase.
2. Tokenize Unicode letters/numbers plus `+`, `#`, and `.`.
3. Remove grade words and low-information words.
4. Fold a precision-oriented Russian/English core role vocabulary onto stable markers, e.g. developer/разработчик, backend/бэкенд, ML/машинного обучения, designer/дизайнер.
5. Do not perform broad translation or occupation inference.

## 3. Unit identity and demand compilation

Define:

```ts
interface UnitIdentity {
  unitId: string;
  platform: string;
  filterSignature: string;
  canonicalTokens: readonly string[];
}
interface CompiledUnit extends UnitIdentity { query: unknown }
interface CompiledSubscription {
  unitId: string; userId: string; searchName: string; sourceSearch: unknown;
}
interface CompiledDemand { units: CompiledUnit[]; subscriptions: CompiledSubscription[] }
interface DemandInput { userId: string; platform: string; searches: readonly unknown[] }
```

Implement `unitIdentityOf`:

- text fields are `name`, `rationale`, `text`, and `query`;
- filter signature is key-sorted JSON of non-text fields;
- canonical tokens are sorted;
- `unitId` is SHA-256 over platform, NUL, filter signature, NUL, token string.

Implement `tokenSimilarity` as Jaccard similarity after an optional role-token resolver.

Implement `compileDemand(demands, threshold, existing?, resolver?)`:

1. sort input by platform then user ID;
2. exact unit identity wins;
3. otherwise adopt an existing same-platform/same-filter unit at or above similarity threshold;
4. otherwise mint a unit;
5. keep each subscriber's own search name and source object;
6. deduplicate one subscription per `(unitId,userId)`;
7. only replace a representative query with a shorter non-empty wording when the exact identity is the same;
8. never re-cluster units after compilation.

## 4. Cadence and fair scheduling

Define `CadencePolicy { floorMinutes; ceilingMinutes }`.

`nextCadence(current, foundNovelty, policy)` must clamp first, then:

- novelty: halve, rounded, not below floor;
- silence: multiply by 1.5, rounded, not above ceiling.

Define `SchedulableUnit { unitId; platform; subscribers; nextRunAt }` and implement `pickDueUnits`:

- exclude future and unsubscribed units;
- sort by overdue time then ID;
- under a budget, cover every user once before spending spare budget on breadth;
- one shared unit covers all its subscribers.

## 5. Match state machine

Define:

```ts
type MatchState =
  | 'matched' | 'queued' | 'scored'
  | 'alerted' | 'digested' | 'skipped'
  | 'applying' | 'applied' | 'expired';
```

Allowed transitions:

```text
matched  -> queued | expired
queued   -> scored | matched | expired
scored   -> alerted | digested | skipped | expired
alerted  -> applying | skipped
digested -> applying | skipped
skipped  -> applying
applying -> applied | alerted | digested | skipped
applied  -> none
expired  -> none
```

Export `canTransition`, `assertTransition`, and `deliveredStates = ['alerted','digested','skipped','applying','applied']`.

## 6. Career profile and deterministic matching

### Profile contract

Valibot schemas must enforce:

```ts
const careerProfileLimits = {
  tracks: 10,
  titleVariants: 16,
  coreSkills: 30,
  evidence: 8,
} as const;

interface CareerTrack {
  name: string;                  // 2..100
  titleVariants: string[];       // 1..16, each one title/language
  coreSkills: string[];          // 0..30
  evidence: string[];            // 1..8, 2..300
}
interface CareerProfile { version: 1; tracks: CareerTrack[] }
interface StoredCareerProfile { cvHash: string; profile: CareerProfile }
```

Reject packed variants containing spaced `/` or `|`. Implement `normalizeCareerProfileJson` to split packed titles, deduplicate, and clip all arrays only as a final repair. `parseStoredCareerProfile` must reject a mismatched CV hash.

### Evidence output

Define `PrefilterResult` with:

- `regexScore`, `lexicalCosine`, `lexicalScore`, `combinedScore`;
- separate `titleSimilarity`, `skillCoverage`;
- signed `seniorityGap: number | null`;
- `specificity` and `lexicalCosineIdf`, both nullable when unmeasured;
- `filtered`, `expired`, and diagnostic reasons.

Implement:

1. role/title evidence from career tracks;
2. skill phrase evidence against title, description, and key skills;
3. raw lexical cosine after removing likely contact lines, email, URLs, and phone numbers;
4. `combinedEvidenceScore = round(regex*0.75 + lexicalScore*0.25)`, where lexical score is `min(100, round(cosine*300))`;
5. minimum role/skill evidence guard so generic textual similarity cannot admit an unrelated occupation;
6. signed grade difference `(vacancyRank-cvRank)/5`, diagnostic only;
7. advert recency bands: today, week, fortnight (0.92), month (0.8), stale (0.6);
8. hard expiry at `maxAgeDays`, measured from source publication date;
9. unreadable/future dates treated as current rather than guessed stale.

`vacancySemanticText` must concatenate only normalized vacancy evidence.

### IDF

Define `IdfEntry`, `IdfVocabulary`, `IdfLookup`, and `IdfLookups`.

- Use smoothed IDF `log((documents+1)/(seenIn+0.5))`.
- Drop tokens seen in only one document; `unknownIdf` represents exactly that value.
- Return a uniform lookup before a corpus exists.
- Specificity is mean matched title-token rarity normalized by `unknownIdf`.
- Body cosine uses rarity-weighted plain words.
- These values are diagnostics and must not alter current admission arithmetic.

## 7. Learned role equivalence

Define:

```ts
interface RoleEquivalencePair { tokenA: string; tokenB: string; support: number }
type RoleTokenResolver = (token: string) => string;
```

`mineRoleEquivalences` must be precision-first:

- compare title variants within one track;
- only cross-script residuals count;
- pair single-token variants directly;
- for multi-token variants require a shared anchor and exactly one residual per side;
- do not mine same-script adjacent roles;
- accumulate support and lexicographically order pair members.

`createRoleTokenResolver` must build transitive equivalence classes. Learned pairs affect comparison/adoption only, never identity hashing.

## 8. Concurrency utilities

Implement:

- `adaptiveConcurrency(load,min,max)`: min workers at normal load, +1 worker per five queued jobs, bounded by load/max;
- `AdaptiveTaskPool` over `p-limit`, dynamically adjusting concurrency;
- `KeyedTaskScheduler`, serial per key and concurrent across keys;
- `mapConcurrent`, preserving output order;
- `aggregateOrderedProgress`, monotonic across concurrent keys and ordered phases.

Invalid bounds must fail synchronously.

## 9. Port-driven runtime

### Scheduler tick

Define `TickUnit`, `TickDiscovery`, `TickPorts`, and `TickReport`.

`runSchedulerTick` must:

1. load due units;
2. group by platform;
3. calculate per-platform budget as unique subscribers × queries-per-user;
4. fairly select units;
5. call each platform once with a plan;
6. allow bounded cross-platform concurrency;
7. update cadence per unit using per-search novelty when available;
8. leave units due when provider discovery fails;
9. isolate one platform's failure.

`nextWakeMs` clamps to 15 seconds–5 minutes.

### Match-on-ingest

Define `MatchEvidence`, `MatchCandidateInput`, `MatchPorts`, and `MatchReport`.

`matchVacancy` evaluates every approved user independently, ignores one user's lens failure, and writes only evidence at/above the supplied floor.

## 10. Independent engine lanes

Define `DiscoveryPorts`, `JudgmentPorts`, `LoopPorts`, reports, clocks, loop status, and `EngineLoop`.

Discovery order:

```text
tick -> normalize -> match newly normalized IDs
```

Judgment order:

```text
score -> deliver -> retire -> maintain
```

Each stage catches and reports failure without blocking later stages. `createEngineLoop` runs both lanes concurrently, races sleep against stop, keeps observability status, and survives total transient stage failure.

Implement `drainScoring`:

- enumerate scoring users;
- calculate a UTC-day paced ceiling per user;
- use floor fraction default `1/12` at midnight;
- skip a user already at ceiling;
- isolate failures by user;
- never use a global shared budget.

## Acceptance tests

All files below must pass:

- `engine.test.ts`: bilingual canonicalization, stable content identity, demand adoption, input-order stability.
- `equivalence.test.ts`: precision mining, transitivity, cross-language matching and adoption without identity drift.
- `scheduler.test.ts`: cadence bounds, fair subscriber coverage, overdue breadth, delivered wall.
- `runtime.test.ts`: platform plans, per-unit novelty, failure isolation, wake bounds, per-user matching, concurrent platforms.
- `loop.test.ts`: stage order/isolation, retirement/maintenance, paced budgets, independent clocks, stoppability.

Run:

```bash
bun test packages/engine
bun run typecheck
```
