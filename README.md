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
# Fill in .env, start the bot, then send /cv and upload RU followed by EN documents.
npm run dev
```

Important variables:

- `OPENAI_CODEX_AUTH_FILE` for the writable OpenAI Codex OAuth credential JSON
- `FLUE_MODEL` and `FLUE_THINKING_LEVEL` for the shared agent model and reasoning effort
- `SCRAPE_CRON`, `NOTIFY_CRON`, and `DIGEST_CRON` for global collection and delivery schedules
- `SCORE_BATCH_SIZE` (default `500`) for the global fair per-cycle budget; `SCORE_AGENT_CONCURRENCY_MIN`/`MAX` bound the shared adaptive scoring pool (defaults `5`–`10`); `USER_DAILY_SCORE_LIMIT`, `USER_DAILY_APPLICATION_LIMIT`, and `USER_DAILY_SEARCH_PROFILE_LIMIT` set rolling 24-hour user limits
- `SEARCH_PLATFORMS` (defaults to `hh,hirehi,habr,getmatch,geekjob,avito,rabota`)
- `HH_AREA_ID` (`1` is Moscow; used as the default area in the generated HH search profile)
- `PLAYWRIGHT_CHROMIUM_PATH` when Chromium is not in Playwright's standard cache
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_USER_ID` and `TELEGRAM_CHAT_ID` identify the owner's private chat (the values must match); only this owner can approve or revoke users

New users send `/request`; duplicate pending requests are idempotent and rejected/revoked users have a cooldown before resubmission. The owner approves or rejects each request with inline controls. `/users` shows the owner a paginated table with status, CV readiness, and delivery windows; `/revoke <prefix>` revokes a user shown on the current page, and `/usage` shows rolling 24-hour and total LLM usage. Each approved user reviews `/privacy`, then sends `/cv` to upload personal Russian and English CV documents as PDF, Markdown, TXT, or DOCX. Downloads are capped at 20 MB and complex formats are parsed in a disposable, memory-limited, filesystem-restricted child process; legacy binary DOC is intentionally unsupported. Only normalized text, canonical document blocks, source metadata, and hashes are stored in SQLite; uploaded files are never persisted. `/cv ru` and `/cv en` replace one template. After both exist, Flue regenerates that user's platform profiles within a daily limit; repeated updates collapse to the newest CV hash, and the next scheduled shared scan uses the new profiles. The owner controls global `/scrape`, `/notify`, and `/digest` crons. Users can limit proactive delivery with `/window 09:00-22:00 Europe/Moscow`; overnight windows are supported and `/window off` allows delivery anytime. Messages queued outside a window are released when it opens. `/search <query>` searches the user's scored vacancies through FTS5. `/export_me` returns an in-memory JSON export; `/delete_me confirm` permanently removes personal data and user-scoped Flue history while preserving approved access and shared vacancies.

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

## deployment host deployment

The deployment host needs Docker Engine with the Compose plugin. The local machine needs `ssh`, `scp`, and `rsync`.

```bash
chmod +x scripts/deploy-deployment host.sh
./scripts/deploy-deployment host.sh user@your-deployment host
```

This uploads the source, `.env`, and OpenAI Codex OAuth JSON, builds on the deployment host, and runs the service with `restart: unless-stopped`. It defaults to `~/hh-jobseeker`; override `REMOTE_DIR`, `SSH_PORT`, or `OPENAI_CODEX_AUTH_SOURCE` as needed.

Updates use the same command. Operations:

```bash
ssh user@your-deployment host 'cd ~/hh-jobseeker && docker compose logs -f jobseeker'
ssh user@your-deployment host 'cd ~/hh-jobseeker && docker compose restart jobseeker'
```

## Privacy and retention

- CV text, canonical blocks, hashes, derived profiles and embeddings, scores, usage records, and model conversation state are stored in owner-only SQLite files.
- Relevant CV and vacancy content is sent to the configured third-party model provider for profile generation, scoring, and application tailoring. Users receive this notice through `/privacy` before upload.
- Original uploads and generated PDFs are held only in memory. Verbose traces redact CV/model bodies, and log forwarding applies a second redaction pass.
- `/export_me` exports the requesting user's data. `/delete_me confirm` deletes active user-scoped data and Flue history; shared vacancies and approved access remain.
- Production storage and backups must be encrypted by the host/deployment host. Backups are retained for at most 30 days, after which deleted user data is no longer recoverable. Operational logs are retained for at most 7 days and must not be collected with `TRACE_VERBOSE=true` in production.

See [SECURITY.md](SECURITY.md) for the deployment security baseline and reporting process.

## Behavior

1. On startup and every global `SCRAPE_CRON` (default: 30 minutes), searches derived from every approved user's complete CV set discover candidates. Vacancies are deduplicated and stored once by source ID.
2. Every discovered listing is persisted in one cross-platform candidate queue with per-user search-profile attribution. Candidate ranking uses the best relevance across active users. Vacancy and candidate embeddings are globally shared by content hash, while CV embeddings remain user-scoped.
3. Normalized vacancies pass through a separate full-text prefilter and Flue scoring workflow for each user. Scoring uses round-robin allocations of ten slots per user per pass within the global cycle budget and rolling user limit. Allocations are prepared concurrently and feed one shared adaptive LLM pool: five scoring agents at normal load, scaling one worker per five queued jobs up to ten. Low relevance results are retained per user without consuming LLM calls; CVs, profiles, scores, decisions, and applications are private to that user.
4. On the global `NOTIFY_CRON`, unsent scores at or above `ALERT_SCORE` (default `80`) produce a private alert during each user's delivery window:
   - **Skip** — suppresses the vacancy.
   - **Apply** — manually generates a tailored CV PDF and sends the concise cover letter as a Telegram message.
   - **Open source** — opens the vacancy on HH or HireHi.
5. On the global `DIGEST_CRON`, scores from `DIGEST_MIN_SCORE` up to `ALERT_SCORE` are sent privately as a native Telegram rich table. Delivery waits for the user's configured window: **Apply ID / Score / Vacancy / Link**. Apply IDs are persistent six-letter strings whose shortest table-unique prefixes are bold, similar to `jj` revision IDs. Send either the bold prefix from the latest digest or the full Apply ID to generate that vacancy's tailored CV and supporting cover letter. A rate-limited, edited status message shows task progress while generation runs and is removed when the task finishes.

Useful commands:

```bash
npm run typecheck
npm test
npm run run:cycle   # one scrape + score cycle
npm run build
npm start
```

## Notes

- Discovery is bounded by source page/candidate limits to keep collection polite. Detail normalization uses one score-ranked cross-platform batch; `CANDIDATE_REFRESH_*` reserves a small part of it for closure/content refresh checks.
- `PREFILTER_*` controls the local pre-LLM queue. Ranking combines role/skill regexes (45%), deterministic lexical cosine (15%), and local multilingual semantic cosine (40%). Semantic vectors are cached in SQLite by CV/vacancy content hash; the quantized model files are cached under `SEMANTIC_EMBEDDING_CACHE_DIRECTORY`.
- A deterministic `PREFILTER_AUDIT_PERCENT` sample of filtered vacancies is LLM-scored in reserved audit slots. Calibration compares prefilter and LLM scores and treats the existing `Apply`/`Skip` actions as positive/negative feedback; alert and digest states remain unlabeled.
- Browser cookies and hh.ru session state persist beside SQLite in `data/hh-browser`; HireHi needs no browser session.
- The app supports multiple approved private Telegram users but still requires one running service instance. Its managed child worker does not poll Telegram. Do not run two service instances against the same Telegram token or SQLite file.
- The tailored CV PDF is compiled from canonical CV content with a standard Typst layout. Uploaded source documents and generated PDFs exist only in memory and are not persisted; SQLite stores normalized text, canonical blocks, parser metadata, and source hashes.
- Flue is currently experimental, so its mutually compatible nightly packages are pinned exactly in `package.json`.
