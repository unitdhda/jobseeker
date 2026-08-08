# Operations

Jobseeker is a single long-running process. There are two sensible ways to run it, and they differ only in
packaging:

- **a container** — the repository's `Dockerfile` and Compose topology, which is what a deployment with
  browser-backed sources wants, since those need Chromium and a pinned system layer;
- **the CLI directly** — `jobseeker start` under systemd or any supervisor, which is enough when your sources are
  API-backed.

Everything below applies to both. For first-time setup — database, bot, credentials, sources — see
[self-hosting](self-hosting.md).

## Invariants

- **One Telegram receiver per bot token.** Nothing enforces this. Telegram splits updates between two receivers and
  reports nothing wrong, so a forgotten local process quietly steals half the messages. While polling, no webhook
  may be configured.
- **One engine loop.** `RUN_JOBS=true` expresses intent; the loop starts only once its process takes a PostgreSQL
  advisory lock. A second one logs `Another process holds the engine-loop lock` and idles — a misconfiguration to
  fix, not a supported topology.
- **PostgreSQL is the only runtime database**, and `packages/app/schema.sql` is its only schema of record.
- **The deployment's `extensions/` directory and environment file are assets, not build output.** They are
  untracked by design. Back them up, and never `git clean` or `rsync --delete` over them.
- Never print environment values, tokens, database URLs, OAuth state, encryption keys, or user data — including
  into this document, which deliberately contains no addresses, ports, or paths.

## Running as a container

The repository provides a multi-stage `Dockerfile` (build the `worker` target), a Compose topology under
`docker/`, and a Chromium seccomp profile. From the deployment directory holding `compose.yaml` and its `.env`:

```bash
docker compose --env-file .env up -d --build
docker compose ps
```

Worth knowing about that topology:

- it pins the ownership settings — `TELEGRAM_MODE=polling`, `RUN_JOBS=true` — so the container is the sole receiver
  and sole loop, and everything else must therefore be off;
- the root filesystem is read-only with a `tmpfs` for `/tmp` and a named volume for `/app/data`, so anything that
  must survive a recreation belongs on a volume or in object storage. Credentials in a local `auth.json` do **not**
  survive; see [the credential store](self-hosting.md#where-credentials-are-kept);
- extensions are copied into the image at build time, so changing your sources means rebuilding, not restarting;
- the health port is published on loopback only.

## Running the CLI directly

Install the package, deliver the environment however your supervisor does it, and check before starting:

```bash
npm install @unitdhda/jobseeker
npx jobseeker doctor && npx jobseeker start
```

Under systemd, a unit with `Restart=always`, an `EnvironmentFile=` pointing at your environment file, a
`WorkingDirectory=` holding `extensions/`, and an unprivileged `User=` covers it. Any supervisor that keeps exactly
one process alive works the same way.

## Verifying a running instance

Startup should report, in order: the loaded extensions and how many source providers they registered, Telegram
polling starting, and `Engine loop started; search_units.next_run_at owns the schedule.`

```bash
# container — the image ships no curl, so probe from inside
docker compose exec -T jobseeker bun -e \
  'const p = process.env.PORT; for (const r of ["health", "ready"]) console.log(r, await (await fetch(`http://localhost:${p}/${r}`)).text())'

# CLI
curl -s localhost:"$PORT"/health && curl -s localhost:"$PORT"/ready
```

`/ready` must report PostgreSQL persistence. Then send one inexpensive command to the bot to confirm the receiver
is alive, and use the owner command `/scraper` for the discovery → normalization → scoring → delivery funnel.

Confirm no second receiver exists by asking Telegram whether a webhook is configured — while polling, the healthy
answer is *no webhook*. Print only the derived booleans, never the URL, which may carry routing information.

## Upgrading

Do not force a discovery pass afterwards; wait for a due unit. The judgment lane wakes on its own every two
minutes, so scoring and delivery resume without help.

**Container** — update the source checkout the image builds from, then rebuild and restart:

```bash
git fetch origin main && git reset --hard FETCH_HEAD && git log --oneline -1
docker compose --env-file .env up -d --build jobseeker
```

**CLI** — `npm update @unitdhda/jobseeker`, then restart the service.

**Schema.** `packages/app/schema.sql` is always the complete current schema, written as if creating the database
from nothing. There is no migration series, no down-migration, and no per-release upgrade note: the file is the
only description of what the database should look like, and it is kept whole rather than accumulated in pieces.

For a new database, `jobseeker db init` applies it. For a database that already exists, reconcile it against the
file — `schema.sql` says what the columns are, and adding a missing nullable column is safe while the service is
running, because every instance shares one database and every statement in the code names its columns explicitly.
Widen before the code that writes it, never after, and recover from a mistake by shipping a forward-compatible
revision rather than by reverting the database.

Behaviour changes in the current revision that need nothing applied: the refit validates on the newest quarter of
the corpus rather than on random folds, and compares candidate against incumbent on those same rows with a paired
bootstrap — expect **fewer** refits to be accepted, because the previous gate could not tell a real improvement
from resampling noise. The judgment lane gained an hourly `retire` stage, so matches whose advert passed
`PREFILTER_MAX_AGE_DAYS` while still waiting for the scoring budget move from `matched` to `expired` instead of
staying indistinguishable from what is still pending. And `CALIBRATION_LABEL_SCORE` now defines what the
calibration calls a positive; it defaults to `DIGEST_MIN_SCORE`, so leaving it unset preserves today's behaviour
exactly. Set it explicitly before changing `DIGEST_MIN_SCORE` for delivery reasons, or the next refit will
silently relabel the whole corpus.

## Rolling back

Reset the source checkout to the last known-good commit and rebuild, or install the previous package version and
restart. Do not revert an applied schema change; roll the code forward instead.

## When something looks wrong

```bash
docker compose logs --since 1h jobseeker | grep -iE 'error|fatal' | tail -50
docker compose logs --since 6h jobseeker | grep -E 'Engine (tick|discovery|judgment|score|deliver)'
docker stats --no-stream
```

Judge staleness against the database clock, not your own: compare `select now()` with each unit's `next_run_at`
before concluding that discovery has stopped. A quiet hour is often just cadence.

The probe above assumes the image's own runtime — use `node -e` instead of `bun -e` if yours is Node-based.

Symptom-by-symptom diagnosis — no vacancies, no scores, duplicate alerts, failing documents, OAuth trouble — is in
[troubleshooting](troubleshooting.md).

## Watching the self-calibrating prefilter

The service re-fits the ordering it feeds the LLM once a day and adopts the result only when it measures no worse
(see [architecture](architecture.md#the-prefilter-calibrates-itself)). It announces every attempt, so a line per day
in the log tells you whether anything changed:

```bash
docker compose logs --since 48h jobseeker | grep 'Calibration refit'
```

`accepted` means the new ordering took over; `rejected` means the running one held and nothing changed. Both are
normal — a long run of `rejected` means the current ordering is holding up, not that the mechanism is broken. Every
attempt is also a row in `calibrations` with its metrics, which is the durable record.

Two controls, both blunt on purpose:

- To freeze the ordering exactly as it is, set `CALIBRATION_AUTO_REFIT=false` and restart.
- To undo a fit that made things worse, mark the active row in `calibrations` as not accepted; the service falls
  back to the previous accepted one on restart.

Do not hand-edit coefficients. If you want the ordering to improve rather than merely hold, the lever is
`PREFILTER_EXPLORATION_RATE`: it buys verdicts from below the current bar, which is the only evidence that can tell
the model its bar is wrong. It costs model spend in proportion, so raise it deliberately.

## Backups

Four things, none of which the package can recreate for you:

- the PostgreSQL database — every CV, profile, match, and artifact;
- the environment file;
- the deployment's `extensions/` directory;
- `RUNTIME_STATE_ENCRYPTION_KEY`, without which everything in the state bucket is unreadable.

Test a restore before you need one.
