# Assignment 06 — CLI, packaging, deployment, security, and validation

## 1. Published package

Publish `packages/app` as `@unitdhda/jobseeker` with:

```text
bin/jobseeker.mjs
dist/
fonts/
schema.sql
LICENSE
README.md
```

Runtime requirement is Node 23.6+; Bun 1.3+ is also supported. The build must avoid Bun-specific APIs.

Vite SSR inputs:

- `server` → `src/web.ts`;
- `cli` → `src/cli.ts`;
- `worker` → `src/worker.ts`;
- `cv-worker` → `src/cv-worker.ts`;
- `refresh-profiles` → `src/profile-refresh.ts`.

Bundle internal `@jobseeker/*` workspaces, keep third-party dependencies external, and emit PDF.js worker asset. App's production dependencies must include every external dependency inherited from bundled workspaces at the exact same version.

The launcher must support `--env-file <path>`/`--env-file=<path>` for every command, with existing process variables taking precedence.

## 2. CLI commands

Implement:

| Command | Required behavior |
|---|---|
| `jobseeker start` | import and run the HTTP/Telegram/engine service |
| `jobseeker db init` | apply packaged whole schema to empty `public` only |
| `jobseeker credentials create` | interactive Pi-AI OAuth/API-key login |
| `jobseeker credentials [path]` | validate/import provider-keyed auth JSON through locked store |
| `jobseeker refresh-profiles` | refresh missing approved-user profiles concurrently and exit |
| `jobseeker doctor` | check config, runtime, database, fonts, and extensions |
| `jobseeker help` | usage and ownership warning |

### Database initialization

- require `DATABASE_URL`;
- honor PostgreSQL TLS mode;
- reject any existing table in `public`;
- apply `schema.sql` whole;
- report table count;
- always close client.

### Doctor

Check without printing secrets:

- five required variables: database, bot token, owner ID, generation model, scoring model;
- Node/Bun version;
- database reachability and `users` table;
- packaged fonts directory;
- non-empty extensions directory.

Return non-zero when any check fails.

### Credential CLI

- terminal-only interactive create;
- list providers and OAuth/API-key methods;
- secret prompt must not echo pasted values (display bullets only);
- import validates object entries with `oauth|api_key` type;
- require database for advisory-lock serialization;
- report provider IDs/types/backend, never values.

## 3. HTTP service

Use Hono and `@hono/node-server`.

Routes:

- `GET /health` → `{ok:true}`;
- `GET /ready` → PostgreSQL persistence status or 503;
- `POST /telegram/webhook` only in webhook mode.

Webhook requirements:

- 32–256 URL-safe secret;
- timing-safe header comparison after equal-length check;
- valid JSON and non-negative safe `update_id`;
- durable claim before handling;
- duplicate returns success;
- complete/fail claim after processing;
- bounded/redacted errors.

Validate port 1–65535. On SIGTERM/SIGINT stop engine, Telegram, worker, HTTP server, and pool in order.

## 4. Telegram ownership modes

Supported modes:

- `polling`: one long-running receiver; webhook must be absent;
- `webhook`: initialize bot handlers and expose webhook route; no poller anywhere;
- `off`: no receiver.

There is no receiver lock. Operational checks must explicitly verify exactly one receiver. Engine lock does not protect Telegram updates.

## 5. Environment reference

Provide a complete annotated `.env.example` grouped as:

1. Telegram token/owner/mode/webhook;
2. extension provider selection and extension-specific source settings;
3. page/query/new-listing/normalization/refresh limits;
4. prefilter and advert age;
5. AI credential file and model roles;
6. prescore/full-score batches, retries, thresholds, exploration;
7. per-user budget and artifact/profile limits;
8. cadence and concurrency;
9. delivery/timezone/locale;
10. PostgreSQL/TLS/pool;
11. encrypted object state;
12. browser profile path.

Every parser default/range and all cross-field constraints in code must agree with the reference.

## 6. Reference container

Use `node:24-slim`. The reference deployment installs the published package pinned by deployment `package.json`; it does not compile the checkout.

Dockerfile requirements:

- production npm install;
- copy deployment extension directory;
- install extension dependencies;
- install Chromium only if Playwright extension exists;
- create node-owned `/app/data`;
- run non-root;
- healthcheck `/health`;
- execute `jobseeker start`.

Compose requirements:

- one jobseeker service, polling and jobs explicitly on;
- restart policy and init;
- read-only root;
- all Linux capabilities dropped;
- no-new-privileges;
- Chromium-compatible seccomp profile;
- PID, memory, CPU limits;
- bounded `/tmp` tmpfs;
- persistent data volume;
- health port bound to loopback only;
- private network;
- no Docker socket or unrelated host mounts.

Extensions may add private sidecars. Inference sidecars must not expose a public host port.

## 7. Security requirements

### Secrets and personal data

Never log:

- environment values;
- database URLs;
- bot/OAuth/API tokens;
- credentials/cookies;
- CV text or canonical document;
- vacancy descriptions;
- search queries/rationales/query URLs;
- cover letters/tailored CV content;
- email/chat/user payloads.

Trace serialization must recursively redact sensitive keys and bound arrays/strings. Error summaries must redact URLs, Telegram tokens, authorization headers, emails, and common secret fields.

### Upload and rendering isolation

- enforce upload and extracted-text limits;
- validate file signatures and safe DOCX expansion;
- isolate parser process;
- escape all Typst input and ban external reads/imports;
- do not persist original uploads or generated PDFs.

### Network

- source HTTPS allowlists and public DNS only;
- revalidate redirects;
- bound source and Telegram downloads;
- health endpoint exposes no secret;
- webhook uses timing-safe shared secret;
- object state encrypted with authenticated path binding.

### Database/privacy

- parameterized queries;
- state predicates guard races;
- user deletion contract implemented and tested;
- backups encrypted and retained according to operator policy;
- logs bounded and retained no longer than operational policy.

## 8. Release workflow

A manual GitHub Actions release must:

1. check out source;
2. install pinned Bun and Node 24;
3. `bun install --frozen-lockfile`;
4. typecheck;
5. run unit tests;
6. build;
7. `npm pack` app;
8. install tarball in an external temp project;
9. run `npx jobseeker help` under Node;
10. publish with npm provenance.

Do not publish domain workspaces; they are bundled internal implementation packages.

## 9. Test inventory and required gates

### Fast deterministic suite

Root command:

```bash
bun --no-env-file test --max-concurrency=1 \
  tests/*.test.ts packages/*/tests/*.test.ts
```

The normal suite must not use developer `.env`, network-dependent live model calls, or production database data.

Coverage by file:

| Area | Test files |
|---|---|
| boundaries | `tests/package-boundaries.test.ts` |
| engine | `engine`, `equivalence`, `scheduler`, `runtime`, `loop` |
| CV | `cv-document`, `cv-evidence`, `cv-layout`, app `cv-adapters` |
| store factory | `packages/store/tests/factory.test.ts` |
| source runtime/security | `factory`, `sources`, `api-driver`, `drivers`, `ip-addresses`, `source-url-policy` |
| examples | `examples`, `example-load`, `example-template-limits`, `company-providers`, source-specific suites |
| app contracts | `application-schema`, `career-profile-repair`, `profile-prompt`, `scoring-contract`, `prescoring`, `prefilter` |
| app safety/runtime | `concurrency`, `extensions`, `encrypted-state-store`, `security`, `workflow-spam` |
| Telegram presentation | `i18n`, `digest-page`, `search-profile-message`, `usage-chart`, `scraper-status` |

### PostgreSQL integration

```bash
bun --env-file=.env packages/app/tests/database-postgres.integration.ts
```

Use an initialized compatible database and ensure test-generated rows are cleaned. This gate validates repository SQL and advisory locks, not just TypeScript behavior.

### Build/package

```bash
bun run typecheck
bun run test
bun run build
cd packages/app
npm pack
```

Then install the tarball into an empty external directory and run the CLI help command with Node.

### Optional/live suites

Live scoring benchmarks and Claude CLI smoke tests are manual. They require credentials and may spend quota. They must never be included in `bun run test`.

## 10. Operational acceptance checklist

Before calling an instance complete:

- [ ] Database is PostgreSQL 15+ and schema matches `schema.sql`.
- [ ] Backups of database, environment, extensions, and encryption key exist and restore.
- [ ] `jobseeker doctor` passes on the runtime host.
- [ ] Extensions load with expected source/AI provider counts.
- [ ] Exactly one Telegram receiver owns the token.
- [ ] No webhook exists during polling.
- [ ] Exactly one process holds engine-loop lock.
- [ ] `/health` and `/ready` pass.
- [ ] Engine startup reports `search_units.next_run_at` schedule ownership.
- [ ] `/scraper` shows full discovery→normalization→match→score funnel.
- [ ] `/usage` reports configured model IDs and bounded accounting.
- [ ] CV upload preview/confirm/reject works for supported formats.
- [ ] Alert, digest pagination, skip, CV, and letter actions work.
- [ ] Same-CV artifact requests resend without LLM usage.
- [ ] `/export_me` and `/delete_me confirm` match retention documentation.
- [ ] Browser state survives recreation where configured.
- [ ] Generated PDFs use bundled fonts and preserve extracted text.

## 11. Failure/rollback requirements

- A failed source must not advance its units.
- A failed discovery stage must not stop normalization or future loops.
- Slow browser discovery must not block judgment/delivery.
- Failed scoring claims return to matched and cool down.
- Telegram send failure must not mark alert/digest delivered.
- Schema changes are rolled forward; do not down-migrate live data.
- Rollback means installing the last known-good package/container while retaining a forward-compatible schema.
- Never force a discovery pass after deployment; wait for due units.
- Never use `git clean` or `rsync --delete` over deployment extension/environment assets.

## Final completion command set

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
bun run test:postgres
bun audit
```

A successful command set is necessary but not sufficient: ownership, health, extension count, runtime funnel, privacy behavior, and restore testing are also required.
