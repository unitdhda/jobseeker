# Troubleshooting

Start with the stage that is not moving. Jobseeker is deliberately bounded, so “nothing arrived” often means work is
waiting behind cadence, normalization, lexical filtering, or a paced budget—not that the service is down.

For production commands and ownership changes, use [operations](operations.md). Do not start local polling or a local
engine loop against production while investigating.

## Fast health check

1. Is exactly one Telegram receiver active?
2. Is exactly one process running with `RUN_JOBS=true`?
3. Do `/health` and `/ready` pass?
4. Is the Telegram webhook absent when polling is active?
5. Does `/scraper` show discovery, normalization, parser errors, and scoring activity?
6. Does `/usage` show the expected model IDs and recent turns?
7. What does PostgreSQL think the current time is?

Read bounded logs and aggregate counters; avoid dumping CVs, vacancy descriptions, tokens, or credentials.

## No vacancies are arriving

Work through the funnel in order.

### 1. No discovery

Check:

- the source is present in `SEARCH_PLATFORMS`;
- active search units exist for that platform;
- units have subscribers;
- `next_run_at` is due according to database time;
- the source is reachable from the scraping host;
- the adapter is not consistently returning captcha, 403, or parser errors.

A source adapter being available in code does not make it viable from every egress network.

### 2. Discovery but no normalization

Look at `/scraper` queue and failure counts. Normalization is bounded per user and per source. A large listing backlog
can be healthy while only a limited number are fetched in full each pass.

Common causes:

- browser or request deadline;
- closed/removed vacancy;
- changed page markup;
- source rate limiting;
- advert too old;
- repeated failed rows waiting for retry time.

### 3. Normalization but no matches

The per-user lexical lens may reject the vacancy. Check:

- `PREFILTER_MIN_SCORE`;
- whether the CV actually contains evidence for the role;
- source title quality;
- advert age versus `PREFILTER_MAX_AGE_DAYS`;
- whether the user's CV/profile was regenerated after a major CV change.

Do not lower the floor from one anecdote. Compare score bands with downstream digest and alert yield.

### 4. Matches but no LLM scores

Check:

- queued versus matched states;
- `AI_SCORING_MODEL` availability;
- per-user paced allowance in `accounts`;
- scoring batch retries and deadlines;
- credential expiry or provider usage limits;
- whether the independent judgment lane is waking.

The daily budget accrues through the UTC day. A user can be temporarily at the paced ceiling without exhausting the
full daily limit.

### 5. Scores but no Telegram delivery

Check:

- `ALERT_SCORE` and `DIGEST_MIN_SCORE`;
- user delivery window, digest time, and timezone;
- match state—already alerted, digested, skipped, or applied rows must not deliver again;
- Telegram API errors;
- whether the user still has approved access.

## hh.ru times out waiting for a title

`waitFor: Timeout ... vacancy-title` means the expected vacancy page did not appear. It may be:

- a closed or archived vacancy;
- a removed page returning a friendly HTTP 200 response;
- a captcha or anti-bot page;
- a redirected/changed layout;
- a genuinely slow page.

Current parsing checks closed-page markers before waiting and again after timeout. If errors persist:

1. inspect only safe page-state markers, not the full personal browsing profile;
2. verify the persistent browser profile is writable and survives restarts;
3. solve captcha interactively in that same profile;
4. confirm the failure is per page, not caused by a batch-wide deadline;
5. add a parser fixture before changing selectors.

Do not add HH browser parallelism as a timeout fix.

## Scores look too low or too high

The LLM score is not the lexical score. The lexical stage decides whether evaluation is worth paying for; the LLM
then judges role compatibility, seniority, responsibilities, domain, format, location, and blockers.

Check:

- whether the authoritative CV is current;
- whether the vacancy description normalized fully;
- hard-rejection reasons;
- missing versus explicitly incompatible requirements;
- the model ID and reasoning level recorded for that event;
- distributions across fresh data rather than one vacancy.

Changing alert thresholds can create delivery spikes and should follow a distribution/yield review.

## A tailored CV or letter never arrives

Check for errors in this order:

1. The callback handler accepted the button press.
2. No job for the same user/vacancy/artifact is already running.
3. The user remains approved.
4. The relevant daily artifact limit is not exhausted.
5. `AI_MODEL` exists and its credential is valid.
6. Generated JSON passed the application schema.
7. Typst and required fonts are available for a CV.
8. Telegram accepted the message or document.

A failure before generation creates no LLM usage event. A schema/model failure creates one or more LLM events and a
failure notice. A Telegram send failure can occur after generation.

## A repeat document behaves unexpectedly

Delivered artifacts are keyed to the CV hash.

- Same user + vacancy + artifact + unchanged CV → resend cached artifact.
- Changed CV hash → regenerate and replace the artifact.
- CV cache stores a Telegram `file_id`, not PDF bytes.
- Letter cache stores the delivered text.

If an unchanged request regenerates, inspect `matches.application_artifacts` for the artifact key and matching
`cvSha256`. If a changed CV resends stale content, verify the saved `cv_documents.cv_sha256` actually changed.

## The wrong model is running

Read the live environment without printing credentials:

```bash
printf 'generation=%s scoring=%s fallback=%s\n' \
  "$AI_MODEL" "$AI_SCORING_MODEL" "$AI_SCORING_FALLBACK_MODEL"
```

Then aggregate recent model events:

```sql
select model, count(*) turns, sum(total_tokens) tokens, sum(cost_usd) catalog_cost
from usage_events
where kind = 'llm' and occurred_at >= now() - interval '1 hour'
group by model
order by model;
```

A role with a blank model fails at request time deliberately. A provider being registered does not route traffic to
it; only the configured `provider/model` identifier does.

## Cost data looks wrong

`usage_events` records:

- uncached input tokens;
- output tokens;
- cache-read tokens;
- cache-write tokens;
- total tokens;
- provider/model identifier;
- catalog or provider-reported cost.

For providers with catalog pricing, expected cost is:

```text
(input × input_rate
 + output × output_rate
 + cache_read × cache_read_rate
 + cache_write × cache_write_rate) / 1,000,000
```

Pricing tiers apply to the whole request when its total input crosses the model's threshold. OAuth and subscription
catalog cost may be a useful operational estimate without being money charged on an invoice.

## OAuth fails after working earlier

Check derived metadata only: provider present, credential type, expiry state, and whether refresh succeeded. Never
print access or refresh tokens.

Jobseeker serializes refresh through the credential store. In encrypted runtime-state mode, verify all of these are
configured together — a partial set silently means local-file mode, and a rotated token then dies with the
container:

- `STATE_STORAGE_URL` and `STATE_STORAGE_KEY`;
- `STATE_STORAGE_BUCKET`;
- `RUNTIME_STATE_ENCRYPTION_KEY`;
- PostgreSQL connectivity for refresh serialization.

If replacing an OAuth document in the encrypted runtime state, make the overwrite explicit and verify a tiny
completion before restarting production. A rotated refresh token must be persisted; restoring an older credential
file can invalidate future refreshes.

## Duplicate alerts or missing Telegram commands

Treat this as an ownership incident.

Possible causes:

- polling and webhook active for the same token;
- two polling processes;
- a local development process pointed at production.

Stop the unintended owner first, then verify webhook state and process/container ownership. Duplicate *alerts* from
two engine loops are the one case with a guard: the loop holds a PostgreSQL session advisory lock and a second
`RUN_JOBS=true` process logs `Another process holds the engine-loop lock` and idles. Duplicate Telegram *reception*
has no guard at all — that is the case to hunt first.

## Digest navigation or IDs fail

Check:

- the message is the current addressable digest snapshot;
- callback page index is within the new page count;
- Telegram permits editing the message;
- the typed reference contains only one to six letters;
- the prefix resolves uniquely among the user's scored vacancies.

The bold text is the minimum unique prefix, not the only valid prefix. Any longer unambiguous prefix and the full ID
must resolve.

## Database readiness fails

`/health` only proves the process is running. `/ready` also checks PostgreSQL.

Check:

- `DATABASE_URL` is present in the running process;
- TLS mode matches the database;
- pool size fits the deployment;
- DNS and egress reach the database;
- schema matches `packages/app/schema.sql`;
- the database clock and disk are healthy.

Do not “fix” readiness by falling back to a local database. PostgreSQL is the only runtime store.

## Still unresolved?

Collect a bounded, redacted incident packet:

- running revision;
- receiver and engine-loop owner;
- `/health` and `/ready` results;
- webhook configured/pending/error booleans;
- loaded extensions and registered source providers;
- `/scraper` aggregate funnel;
- recent model IDs and aggregate usage;
- last relevant error classes and counts;
- database `now()`.

Then follow the incident and rollback procedures in [operations](operations.md).
