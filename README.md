# Jobseeker

Small self-hosted service that searches Russian vacancy platforms, stores a shared deduplicated vacancy pool, and privately scores vacancies for approved Telegram users with Flue.

## Stack

- **Node.js + TypeScript** — one bot/server process plus one local child worker for LLM and scrape workloads; no external queue or microservices.
- **Playwright + Chromium** — searches hh.ru; other sources use public server-rendered pages, sitemaps, structured data, or an official API.
- **SQLite (`node:sqlite`)** — one `data/jobseeker.db` for shared vacancies, FTS5 search, discovery attribution, per-user CVs/scores, access control, usage, and Flue's durable conversations. No ORM.
- **Flue** — three agents/workflows: derive platform-specific searches, score a vacancy, and prepare truthful tailored documents on request.
- **grammY** — long polling, inline actions, and Telegram's native `sendRichMessage` table block for digests.
- **croner** — global scrape, alert, and digest schedules plus queued delivery-window release.

This is intentionally a multi-user, single-service design with one owner-controlled Telegram bot. Telegram polling and command handling stay in the server process; Flue workflows, scoring, tailoring, and scrape cycles run serially in a child worker so long jobs cannot block bot responses.

## Setup

Requires Node.js 22.19+.

```bash
npm install
npx playwright install chromium
cp .env.example .env
# Fill in .env, start the bot, then send /cv and upload one CV in any language.
npm run dev
```

Important variables:

- `OPENAI_CODEX_AUTH_FILE` for the writable OpenAI Codex OAuth credential JSON
- `FLUE_MODEL` and `FLUE_THINKING_LEVEL` for the shared agent model and reasoning effort
- `CYCLE_CRON` for the single scrape/scoring/alert/digest process tick (default: every 30 minutes)
- `USER_SCORE_LIMIT_PER_CYCLE` caps every user at 3 scores per cycle, with no global or daily scoring cap; `SCORE_AGENT_CONCURRENCY_MIN`/`MAX` bound the shared adaptive scoring pool (defaults `5`–`10`); `USER_DAILY_APPLICATION_LIMIT` and `USER_DAILY_SEARCH_PROFILE_LIMIT` set rolling 24-hour user limits
- `SEARCH_PLATFORMS` (defaults to `hh,hirehi,habr,getmatch,geekjob,avito,rabota`)
- `HH_AREA_ID` (`1` is Moscow; used as the default area in the generated HH search profile)
- `PLAYWRIGHT_CHROMIUM_PATH` when Chromium is not in Playwright's standard cache
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_USER_ID` and `TELEGRAM_CHAT_ID` identify the owner's private chat (the values must match); only this owner can approve or revoke users

New users send `/request`; duplicate pending requests are idempotent and rejected/revoked users have a cooldown before resubmission. The owner approves or rejects each request with inline controls. `/users` shows the owner a paginated table with status, CV readiness, and delivery windows; `/revoke <prefix>` revokes a user shown on the current page, and `/usage` shows rolling 24-hour and total LLM usage. Each approved user reviews `/privacy`, then sends `/cv` to upload one authoritative CV in any language as PDF, Markdown, TXT, or DOCX. Downloads are capped at 20 MB and complex formats are parsed in a disposable, memory-limited, filesystem-restricted child process; legacy binary DOC is intentionally unsupported. Only normalized text, canonical document blocks, source metadata, and hashes are stored in SQLite; uploaded files are never persisted. A later `/cv` upload atomically replaces the source of truth, invalidates derived profiles and scores, and triggers profile regeneration within the daily limit. High-score alert explanations are retained only until delivery, while tailored CVs and cover letters are faithfully translated into each vacancy's language without inventing facts. The process schedule is configured only through `CYCLE_CRON`; Telegram users cannot change it. `/window` guides each user through notification start, notification end, digest time, and a fixed UTC offset such as `+3` or `+3:30`; overnight windows are supported. Alerts wait for an open notification window, while each user's digest runs once per local day at the first process tick after their chosen time. `/search <query>` searches the user's scored vacancies through FTS5. `/export_me` returns only normalized CV text, canonical document JSON, search profiles, and URL/score pairs; `/delete_me confirm` permanently removes personal data while preserving approved access and shared vacancies.

## Vacancy sources

- **HH** — Playwright browser search with a persistent session.
- **HireHi** — public SEO landing pages and vacancy JSON-LD; its robots-disallowed search API is not used.
- **Habr Career** and **GeekJob** — public search/listing pages plus vacancy JSON-LD.
- **getmatch** — its public sitemap and server-rendered vacancy pages; its robots-disallowed API is not used.
- **Avito Работа** — allowed public IT/tag pages and their server-rendered listing data; descriptions may be listing excerpts.
- **Работа.ру** — public role landing pages containing JobPosting JSON-LD.
- **SuperJob** — optional official API integration. Obtain an application key, set `SUPERJOB_API_KEY`, and add `superjob` to `SEARCH_PLATFORMS`.

## Container

The Compose service keeps SQLite, including extracted per-user CV content, in a named volume. It mounts a writable OAuth directory so refreshed tokens persist. Telegram uses long polling, so no public HTTP endpoint or reverse proxy is required; port 3000 is bound only to deployment host localhost for health checks.

```bash
cp .env.example .env
# Fill .env and place OAuth JSON under auth/auth.json.
docker compose up -d --build
docker compose logs -f jobseeker
curl http://127.0.0.1:3000/health
```

The `jobseeker-data` volume survives image and container replacement. Compose runs the service read-only and non-root, drops all Linux capabilities, enables no-new-privileges, bounds memory/PIDs/CPU, and exposes only explicit writable data/auth/model mounts. Chromium sandboxing remains enabled.

## Privacy and retention

- CV text, canonical blocks, source metadata and hashes, derived profiles and embeddings, numeric scores, usage records, and delivery/application state are stored in owner-only SQLite files. Score rows contain only user/vacancy identifiers and the numeric score.
- High-score alert explanations are stored separately only while awaiting delivery and are deleted immediately after the Telegram alert succeeds.
- Relevant CV and vacancy content is sent to the configured third-party model provider for profile generation, scoring, and application tailoring. Users receive this notice through `/privacy` before upload.
- Completed one-shot model conversations are purged; active conversations remain durable only for crash recovery. Original uploads and generated PDFs are held only in memory, and cover letters are not retained after their workflow settles. Verbose traces redact CV/model bodies, and log forwarding applies a second redaction pass.
- `/export_me` exports only normalized CV text, canonical document JSON, search profiles, and vacancy URL/score pairs. `/delete_me confirm` deletes active user-scoped data and unfinished Flue history; shared vacancies and approved access remain.
- Production storage and backups must be encrypted by the host/deployment host. Backups are retained for at most 30 days, after which deleted user data is no longer recoverable. Operational logs are retained for at most 7 days and must not be collected with `TRACE_VERBOSE=true` in production.

See [SECURITY.md](SECURITY.md) for the deployment security baseline and reporting process.

## Behavior

1. On startup and every `CYCLE_CRON` tick (default: 30 minutes), searches derived from every approved user's complete CV set discover candidates. Each user/platform search stops after 10 globally unseen vacancies; each query scans at most five pages. GetMatch inspects up to 100 newest sitemap matches to find the same 10-new target. Vacancies are deduplicated and stored once by source ID.
2. Every discovered listing is persisted in one cross-platform candidate queue with per-user search-profile attribution. Candidate ranking uses the best relevance across active users. Each cycle can normalize up to 10 attributed candidates per user; overlapping candidates are normalized once, and unused deduplicated capacity can be used for closure/content refresh checks. Vacancy and candidate embeddings are globally shared by content hash, while CV embeddings remain user-scoped.
3. Normalized vacancies pass through a separate full-text prefilter and Flue scoring workflow for each user. Every user receives up to three scoring attempts per cycle, with no global cycle budget or rolling daily scoring limit. User allocations run concurrently and feed one shared adaptive LLM pool: five scoring agents at normal load, scaling one worker per five queued jobs up to ten. Low relevance results are retained per user without consuming LLM calls; CVs, profiles, numeric scores, decisions, and applications are private to that user.
4. After each cycle, unsent scores at or above `ALERT_SCORE` (default `80`) produce a private alert when the user's notification window is open:
   - **Skip** — suppresses the vacancy.
   - **Apply** — manually generates a tailored CV PDF and sends the concise cover letter as a Telegram message.
   - **Open source** — opens the vacancy on HH or HireHi.
5. After the user's configured local digest time, the first cycle of the day sends scores from `DIGEST_MIN_SCORE` up to `ALERT_SCORE` as a native Telegram rich table: **Apply ID / Score / Vacancy / Link**. It includes only newly scored, unseen vacancies since that user's previous digest and excludes alerted, previously digested, skipped, applying, and applied vacancies. Apply IDs are persistent six-letter strings whose shortest table-unique prefixes are bold, similar to `jj` revision IDs. Send either the bold prefix from the latest digest or the full Apply ID to generate that vacancy's tailored CV and supporting cover letter. A rate-limited, edited status message shows task progress while generation runs and is removed when the task finishes.

Useful commands:

```bash
npm run typecheck
npm test
npm run run:cycle   # one scrape + score cycle
npm run build
npm start
```

## Notes

- Discovery is bounded by `SEARCH_NEW_VACANCY_LIMIT` plus source page/candidate safety caps to keep collection polite. Detail normalization uses per-user attributed batches combined into one deduplicated cross-platform queue; `CANDIDATE_REFRESH_*` uses spare capacity left by short or overlapping user queues for closure/content refresh checks.
- `PREFILTER_*` controls the local pre-LLM queue. Ranking combines role/skill regexes (45%), deterministic lexical cosine (15%), and local multilingual semantic cosine (40%). Semantic vectors are cached in SQLite by CV/vacancy content hash; the quantized model files are cached under `SEMANTIC_EMBEDDING_CACHE_DIRECTORY`.
- A deterministic `PREFILTER_AUDIT_PERCENT` sample of filtered vacancies is LLM-scored in reserved audit slots. Calibration compares prefilter and LLM scores and treats the existing `Apply`/`Skip` actions as positive/negative feedback; alert and digest states remain unlabeled.
- Browser cookies and hh.ru session state persist beside SQLite in `data/hh-browser`; HireHi needs no browser session.
- The app supports multiple approved private Telegram users but still requires one running service instance. Its managed child worker does not poll Telegram. Do not run two service instances against the same Telegram token or SQLite file.
- The tailored CV PDF is compiled from canonical CV content with a standard Typst layout. Uploaded source documents and generated PDFs exist only in memory and are not persisted; SQLite stores normalized text, canonical blocks, parser metadata, and source hashes.
- Flue is currently experimental, so its mutually compatible nightly packages are pinned exactly in `package.json`.
