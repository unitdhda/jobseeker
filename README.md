# Jobseeker

Private, self-hosted Telegram service for vacancy discovery, scoring, digests, and tailored applications.

Jobseeker accepts PDF, DOCX, Markdown, and text CVs; builds user-specific search profiles; discovers vacancies through runtime extensions; deduplicates and scores matches; sends alerts and daily digests; and generates evidence-bound tailored CVs or cover letters.

## Requirements

- Node.js 23.6+ or Bun 1.3+
- PostgreSQL 15+
- a Telegram bot token
- deployment-owned vacancy-source extensions
- configured AI providers and models

PostgreSQL is the only runtime store. Exactly one process may receive Telegram updates for a bot token.

## Install

The application is published as [`@unitdhda/jobseeker`](https://www.npmjs.com/package/@unitdhda/jobseeker):

```sh
npm install -g @unitdhda/jobseeker
jobseeker help
```

Copy [`.env.example`](.env.example), configure the required values and extensions, then initialize **only an empty** PostgreSQL `public` schema:

```sh
jobseeker --env-file /path/to/jobseeker.env db init
jobseeker --env-file /path/to/jobseeker.env doctor
jobseeker --env-file /path/to/jobseeker.env start
```

`db init` refuses a non-empty schema. Existing installations require an explicit forward migration.

## Repository

The workspace is split into bounded domains:

- [`packages/engine`](packages/engine) — pure deterministic pipeline policy;
- [`packages/cv`](packages/cv) — CV extraction, evidence checks, and PDF rendering;
- [`packages/sources`](packages/sources) — safe generic source runtime and drivers;
- [`packages/store`](packages/store) — PostgreSQL schema and repositories;
- [`packages/app`](packages/app) — CLI, HTTP, Telegram, AI, workers, and composition;
- [`extensions`](extensions) — runtime-loaded source and AI providers.

The complete architecture, invariants, implementation assignments, and acceptance gates are documented in [`docs/implementation-from-scratch`](docs/implementation-from-scratch/README.md).

## Development

```sh
bun run typecheck
bun run test
bun run build
bun run test:postgres  # requires a configured compatible test database
```

The deterministic test suite does not load developer environment files or call live models.

## Deployment and operations

A hardened reference Node 24 container and Compose deployment are under [`docker/vps`](docker/README.md). It installs the published npm package rather than compiling the checkout.

Operational invariants:

- polling and webhook ownership must never overlap;
- the engine loop runs only while holding PostgreSQL advisory lock `jobseeker-engine-loop`;
- `/health` reports process liveness and `/ready` checks PostgreSQL;
- uploaded files and generated PDF bytes are not persisted;
- deployment environment, extensions, database, and encryption keys must be backed up and restore-tested.

See [`packages/app/README.md`](packages/app/README.md) for CLI and runtime details and [`docker/README.md`](docker/README.md) for deployment guidance.

## License

[MIT](LICENSE)
