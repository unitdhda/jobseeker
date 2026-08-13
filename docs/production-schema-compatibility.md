# Production schema compatibility and 0.2.0 migration

Validation date: 2026-08-13

## Status

Production was cut over from 0.1.12 to 0.2.0 on 2026-08-13 after explicit approval for controlled in-place migration. The transactional migration and read-only verifier are:

- `packages/app/migrations/0.1.12-to-0.2.0.sql`
- `packages/app/migrations/verify-0.2.0.sql`

The Supabase pooler could not route a second database, so blue-green cutover was unavailable. Before the approved exception, the sole application writer/Telegram receiver was stopped, a fresh encrypted logical backup was restore-tested in isolated PostgreSQL 17, and that exact backup passed migration, verification, and 0.2.0 repository reads. Production migration then committed transactionally and passed the same verifier.

Production now runs 0.2.0 with exactly one polling receiver and one engine advisory-lock owner. The original 15-table schema remains intact as `legacy_0_1_12` for audit and recovery.

## Audited production snapshot

The source is PostgreSQL 17.6 and approximately 179 MB. The final stopped-writer backup contained:

- 16 users;
- 9 authoritative CVs;
- 8,725 vacancies;
- 10,698 matches;
- 14,411 usage events;
- 14 rewrite-owned tables plus legacy `calibrations`.

All observed lifecycle values fit the 0.2.0 vocabularies. Delivered/application memory included 622 delivered-wall rows and 28 rows with cached artifacts. All cached artifact objects already used the target camelCase schema and valid CV hashes.

## Migration model

The migration is designed and guarded as a clone-first operation. Its production execution was an explicitly approved exception only after stopped-writer backup restoration passed every clone gate. In one transaction it:

1. verifies the exact 0.1.12 table inventory and source bounds;
2. renames source `public` to `legacy_0_1_12`;
3. creates a new `public` from the complete 0.2.0 `schema.sql`;
4. transforms and copies all 14 rewrite tables;
5. verifies every source/target row count and critical lifecycle invariants;
6. commits while retaining the complete legacy schema and `calibrations` table.

No legacy table, column, or payload is dropped. Cleanup is a separate later release after retention approval.

## Explicit transformations

### Users and delivery

- `is_owner smallint` becomes boolean after validating only `0|1`.
- `display_name` becomes `first_name`; `last_name` remains null because legacy data has no reliable split.
- explicit locale sets `locale_selected=true`.
- scalar delivery fields become `{enabled,digestHourUtc,timezone}`.
- lifecycle timestamps are conservatively derived from requested/approved/updated timestamps.

### CV and profiles

- legacy reserved career profile is moved from `search_profiles.__career-profile-v1` to `career_profile` and bound to the authoritative CV hash.
- each provider profile is wrapped as `{cvHash,templateVersion:1,profile}`; all deployed 0.2.0 provider templates are version 1.
- pending CV extraction JSON is decomposed into the target columns. The audited source had no pending rows, but migration remains shape-explicit.

### Vacancies

- scalar salary becomes target JSON only when at least one bound and a canonical three-letter currency exist; legacy values were predominantly RUR plus USD/EUR.
- known numeric experience strings become ranges; blank values become `unspecified`; every other nonblank provider string is preserved as `{kind:"other",label}`.
- free-text employment, schedule, and work-format values are conservatively classified; unknown values become `other`, never guessed into a narrower category.
- legacy self `normalized_vacancy_id` values become null; true cross-row duplicate references survive.
- legacy raw columns remain available in `legacy_0_1_12.vacancies` for audit.
- generated full-text search now includes area. PostgreSQL may ignore an individual lexeme over its 2,047-character FTS limit; source descriptions remain intact.

### Matches and applications

- integer score values become target double precision values.
- missing required lexical diagnostics become zero while the complete legacy row remains retained for audit.
- alert fields map to target short presentation fields; full `score_explanation` survives.
- prescore prompt version becomes text and its timestamp maps to `prescored_at`.
- delivered-wall states receive the best available historical delivery timestamp.
- completed `applied` rows clear active `application_status` and receive application delivery timestamps.
- active `applying/generating` work is preserved.
- application artifact cache objects are copied unchanged after aggregate schema validation.

### Derived/operational data

- search tokens become JSON arrays; query/subscription JSON is renamed.
- IDF corpus update timestamps become rebuild timestamps; legacy token-count metadata remains in the retained schema.
- account `llm_cost_usd` becomes `spent_usd`.
- usage token counts are validated to fit target integers before copy.
- session ownership token is recovered from `token|_claimToken` where present.
- Telegram free-text errors become bounded class `legacy-error`; payload text is retained only in the legacy schema.

## VPS clone validation results

The migration was tested in a PostgreSQL 17 Alpine container on a dedicated Docker bridge with no published port. Production was streamed through `pg_dump|pg_restore`; no dump file or credential file was written.

Passed gates:

- transaction-consistent restore of the active production shape;
- final migration in 20 seconds;
- read-only verifier;
- exact schema-only dump match against a fresh `schema.sql` database (760 normalized lines);
- all 14 source/target table row counts equal;
- 14 target public tables and 15 retained legacy tables;
- career/provider profile envelope validation;
- salary/experience/enum JSON validation;
- delivered-wall and artifact cache validation;
- no vacancy self duplicate references;
- 0.2.0 repository read paths over migrated production-shaped data;
- full store lifecycle in a separate temporary schema, including locks and deletion;
- temporary test schema cleanup;
- 0.2.0 staging image with exact dependency versions and zero npm vulnerabilities;
- `jobseeker doctor`, `/health`, `/ready`, and SIGTERM shutdown with Telegram/jobs off;
- rollback rehearsal by dropping a separately migrated rehearsal database.

## Production cutover record

The final cutover passed these additional gates:

- 0.1.12 stopped cleanly with zero application processes, open transactions, and advisory locks;
- encrypted AES-256 backup size 15,097,632 bytes, ciphertext SHA-256 `baf49f2d8357bf303631af2c52934d9593a0cde6ad643441ec495f001ace0016`;
- exact backup restored with all final counts and migrated in 17 seconds;
- production precondition counts matched the restored backup exactly;
- production migration committed in 30 seconds and verifier passed;
- TLS repository reads, doctor, safe startup, health/readiness, and graceful shutdown passed before receiver enablement;
- stale 0.1.12 extensions were replaced with rewrite extensions after HireHi exposed the legacy string-URL contract;
- corrected production remained healthy with zero restarts, no envelope/URL failures, an empty Telegram webhook, one advisory lock, and natural discovery progress;
- all temporary production-shaped restore containers, volumes, and networks were removed.

## Cutover procedure

Do not use `db init` for this migration.

1. Verify an encrypted backup and perform a restore test.
2. Stop the 0.1.12 Jobseeker service so no Telegram receiver or database writer remains.
3. Take a final transaction-consistent logical backup.
4. Restore into the cutover target database/project.
5. Place `schema.sql` beside `migrations/` and run:

   ```sh
   psql "$TARGET_DATABASE_URL" -X -f migrations/0.1.12-to-0.2.0.sql
   psql "$TARGET_DATABASE_URL" -X -f migrations/verify-0.2.0.sql
   ```

6. Run 0.2.0 `doctor` with Telegram/jobs off.
7. Start 0.2.0 with Telegram off; verify `/health`, `/ready`, repository summaries, fonts, and extensions.
8. Confirm the old receiver is stopped, then enable exactly one 0.2.0 Telegram receiver and engine owner.
9. Do not force discovery; wait for due search units.
10. Retain the old database and `legacy_0_1_12` through the rollback window.

## Rollback

Before enabling 0.2.0 writes, rollback means discarding the migrated target and restarting 0.1.12 against the untouched source database.

After 0.2.0 writes begin, do not point 0.1.12 at the migrated database. Stop 0.2.0, preserve the failed target for diagnosis, and choose either a forward fix or restore the pre-cutover backup according to operator-approved data-loss bounds. Never down-migrate the live schema.
