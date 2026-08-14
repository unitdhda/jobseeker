# Reference VPS deployment

This image installs the published `@unitdhda/jobseeker@0.2.1` package. It does not compile the repository checkout.

## Prepare

1. Copy deployment extensions into `docker/vps/extensions/`. If they need dependencies, include `extensions/package.json` and a lockfile. The image installs Chromium only when that extension dependency tree contains Playwright.
2. Copy the root `.env.example` to `docker/vps/jobseeker.env`, populate it, and set:
   - `DATABASE_URL` to PostgreSQL 15+ reachable from the container;
   - `TELEGRAM_BOT_TOKEN` and `TELEGRAM_USER_ID`;
   - generation/scoring model IDs and credentials;
   - encrypted object state values when browser/OAuth state must survive recreation.
3. Keep `TELEGRAM_MODE=polling` and `RUN_JOBS=true` for this single-service reference topology.
4. Back up the database, environment file, extension directory, and runtime-state encryption key before every change.

```sh
cd docker/vps
docker compose build --pull
# Empty public schema only:
docker compose run --rm jobseeker db init
docker compose run --rm jobseeker doctor
docker compose up -d
docker compose ps
curl --fail http://127.0.0.1:3000/health
curl --fail http://127.0.0.1:3000/ready
```

`db init` refuses any existing table. Existing deployments require a tested forward migration; do not initialize over production.

## Security and ownership

- The root filesystem is read-only; `/tmp` is a bounded tmpfs mount.
- `/app/data` is the only persistent container volume, contains the local credential fallback/browser profile, and is owned by the non-root `node` user.
- All Linux capabilities are dropped; no-new-privileges and the Chromium-compatible seccomp profile are applied.
- The health port is bound to host loopback only.
- The service uses an isolated bridge network with outbound NAT for Telegram/source/AI HTTPS. There is no Docker socket or unrelated host mount.
- Private inference sidecars may join the same bridge but must not publish host ports.
- Exactly one receiver may own a Telegram token. Verify no webhook exists while polling and never scale this service above one replica.
- The engine singleton advisory lock does **not** protect Telegram updates.

## Upgrade and rollback

1. Bump `packages/app/package.json`, `docker/vps/package.json`, and the Compose image tag together.
2. Publish the package through the manual provenance release workflow.
3. Back up and restore-test PostgreSQL and deployment assets.
4. Build and run `doctor` against the candidate image.
5. Deploy without forcing discovery; existing due schedules remain authoritative.

Rollback installs/builds the last known-good package/container while retaining the forward-compatible database schema. Schema changes roll forward; never down-migrate live data. Never run `git clean` or `rsync --delete` over environment or extension assets.

## Operations checklist

- `doctor`, `/health`, and `/ready` pass.
- Expected extension/source/AI provider counts appear in startup diagnostics.
- Exactly one Telegram poller exists and Telegram has no webhook.
- Exactly one process holds the engine-loop lock.
- `/scraper` and `/usage` show a bounded healthy funnel/accounting.
- CV upload, digest/alert/application actions, export, and deletion are exercised after upgrades.
- Generated PDFs use bundled Spectral and JetBrains Mono and preserve extracted Cyrillic/Latin text.
