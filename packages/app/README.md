# @unitdhda/jobseeker

Private self-hosted Telegram vacancy discovery, scoring, digest, and tailored-application service.

## Requirements

- Node.js 23.6+ or Bun 1.3+
- PostgreSQL 15+
- deployment-owned source extensions
- exactly one Telegram receiver per bot token

## Install

```sh
npm install -g @unitdhda/jobseeker
jobseeker help
```

Copy the annotated `.env.example` from the project documentation and configure extensions separately. Initialize only a new empty database:

```sh
jobseeker --env-file /app/data/jobseeker.env db init
jobseeker --env-file /app/data/jobseeker.env doctor
jobseeker --env-file /app/data/jobseeker.env start
```

`db init` refuses a non-empty PostgreSQL `public` schema. Existing installations require an explicit forward migration; never rerun initialization over production.

## Ownership

- `TELEGRAM_MODE=polling`: this process polls; no webhook may exist for the token.
- `TELEGRAM_MODE=webhook`: this process accepts the configured webhook route; no process may poll.
- `TELEGRAM_MODE=off`: no Telegram receiver.
- The engine loop runs only while holding PostgreSQL advisory lock `jobseeker-engine-loop`.

## Privacy

PostgreSQL is the runtime store. Uploaded bytes and generated PDF bytes are not persisted. Tailored CVs pass deterministic evidence validation. Source network access is HTTPS-host/DNS constrained. Runtime browser/OAuth state can be encrypted with AES-256-GCM in compatible object storage.

## Operations

- `GET /health` — process liveness
- `GET /ready` — PostgreSQL readiness
- `/status`, `/usage`, `/scraper` — owner diagnostics
- `/export_me`, `/delete_me` — personal export/deletion

Back up PostgreSQL, environment configuration, deployment extensions, and the runtime-state encryption key. Test restoration before upgrades.
