# Current-capability conformance map

This map records the as-built evidence reviewed while applying the baseline. Paths are repository-relative.

## `cv-vacancy-matching`

| Requirement and scenarios | Implementation evidence | Deterministic/integration evidence | Documentation evidence | Finding |
|---|---|---|---|---|
| Supported CV files — supported extraction; invalid rejection | `packages/cv/src/extract.ts`, `packages/app/src/cv.ts`, `packages/app/src/cv-worker.ts`, `packages/app/src/telegram/actions.ts` | `packages/app/tests/cv-adapters.test.ts`, `packages/app/tests/telegram-actions.test.ts`, CV package tests | `README.md` “What it does”; `packages/cv/README.md`; assignment 04 §§1–3,9 | Covered |
| Confirmation — confirm preview; reject preview | `packages/app/src/telegram/actions.ts`, `packages/store/src/repos.ts` staging/confirmation repositories | `packages/app/tests/telegram-actions.test.ts`; `packages/store/tests/repository-policy.test.ts`; `packages/app/tests/database-postgres.integration.ts` | `README.md` run-through/privacy; assignment 02 §4; assignment 05 §11 | Covered |
| Reusable search demand — successful refresh; one-source isolation | `packages/app/src/profile-refresh.ts`, `packages/engine/src/subscribe.ts`, `packages/store/src/engine-repos.ts` | `packages/app/tests/profile-refresh.test.ts`, `packages/app/tests/workflow-adapters.test.ts`, `packages/engine/tests/engine.test.ts` | `README.md` “How it works”; assignment 01 §3; assignment 05 §4 | Covered |
| User-specific matching — sufficient evidence; unrelated/stale rejection; user isolation | `packages/engine/src/prefilter.ts`, `packages/engine/src/runtime.ts`, `packages/app/src/engine-adapters.ts`, `packages/app/src/workflows.ts` | `packages/engine/tests/runtime.test.ts`, `packages/app/tests/engine-adapters.test.ts`, `packages/app/tests/workflows.test.ts`, scoring/prescoring tests | `README.md` “How it works” and “What it does”; assignments 01 §§6,9 and 05 §§6–7 | Covered |
| Telegram vacancy delivery — high alert; digest range; failed send | `packages/app/src/telegram/delivery.ts`, `packages/app/src/service.ts`, `packages/store/src/repos.ts` | `packages/app/tests/delivery.test.ts`, `packages/app/tests/digest-page.test.ts`, `packages/app/tests/telegram-format.test.ts` | `README.md` “What arrives in Telegram”; assignment 05 §11 | Covered |
| Delivered wall — rediscovery; skip | `packages/engine/src/match-state.ts`, `packages/store/src/engine-repos.ts`, `packages/store/src/repos.ts` | `packages/engine/tests/scheduler.test.ts`, `packages/store/tests/repository-policy.test.ts`, PostgreSQL integration lifecycle coverage | `README.md` “No duplicate delivery”; assignments 01 §5 and 02 §§7–8 | Covered |

## `tailored-applications`

| Requirement and scenarios | Implementation evidence | Deterministic/integration evidence | Documentation evidence | Finding |
|---|---|---|---|---|
| Independent artifacts — CV request; letter request | `packages/app/src/application-schema.ts`, `packages/app/src/application.ts`, `packages/app/src/telegram/callbacks.ts`, `packages/app/src/workflow-adapters.ts` | `packages/app/tests/application-schema.test.ts`, `packages/app/tests/application-workflow.test.ts`, `packages/app/tests/workflow-adapters.test.ts` | `README.md` “What arrives in Telegram”; assignment 05 §8 | Covered |
| Evidence grounding — valid CV; invented CV claim; evidence-bound letter | `packages/cv/src/evidence.ts`, `packages/app/src/application.ts` | `packages/cv/tests/cv-evidence.test.ts`, `packages/app/tests/application-workflow.test.ts` | `README.md` privacy/application sections; assignment 04 §6; assignment 05 §8 | Covered |
| Bounded serialized generation — duplicate action; daily limits | `packages/app/src/telegram/workflow-lock.ts`, `packages/app/src/workflow-adapters.ts`, `packages/app/src/worker.ts` | `packages/app/tests/workflow-spam.test.ts`, `packages/app/tests/telegram-actions.test.ts`, `packages/app/tests/workflow-adapters.test.ts`, `packages/app/tests/worker.test.ts` | assignment 05 §§8–9,11 | Covered |
| CV-hash cache — same hash; changed hash | `packages/app/src/application.ts`, `packages/store/src/repos.ts` artifact repositories | Same-hash coverage in `packages/app/tests/application-workflow.test.ts`; changed-hash generation coverage added during apply | `README.md` Telegram/cache behavior; assignments 02 §8 and 05 §8 | Coverage gap identified: add changed-hash test |
| Telegram artifact delivery — successful PDF; failed send | `packages/app/src/telegram/actions.ts`, `packages/store/src/repos.ts` | `packages/app/tests/telegram-actions.test.ts` | `README.md` “What arrives in Telegram”; assignment 05 §§8,11 | Covered after narrowing the baseline to the implemented failed-send guarantee |
| No persistent PDF bytes — delivered CV | `packages/app/src/application.ts`, `packages/app/src/worker-protocol.ts`; persistence contract stores metadata only | `packages/app/tests/application-workflow.test.ts`, `packages/store/tests/repository-policy.test.ts`, schema tests | `README.md` privacy; assignments 02 §8, 04 §9, and 05 §8 | Covered |

## `telegram-administration`

| Requirement and scenarios | Implementation evidence | Deterministic/integration evidence | Documentation evidence | Finding |
|---|---|---|---|---|
| Owner identity — normal user workflow; owner protected | `packages/store/src/repos.ts` owner seeding/status guard, `packages/app/src/telegram/bot.ts` ordinary approved menu | `packages/app/tests/telegram-bot.test.ts`, `packages/app/tests/commands.test.ts`, PostgreSQL integration access lifecycle | `README.md` owner diagnostics; assignment 02 §3; assignment 05 §11 | Covered |
| User access — list; approve/revoke; non-owner denial | `packages/app/src/telegram/commands.ts`, `packages/app/src/telegram/bot.ts`, `packages/store/src/repos.ts` | `packages/app/tests/commands.test.ts`, `packages/app/tests/telegram-bot.test.ts` | assignment 05 §11 | Covered after reconciling unsupported owner rejection command from baseline |
| AI usage — owner summary; zero activity | `packages/app/src/observability.ts`, `packages/app/src/telegram/commands.ts`, durable summary in `packages/store/src/repos.ts` | `packages/app/tests/usage-chart.test.ts`, `packages/app/tests/commands.test.ts`, repository-policy hourly-series test | `README.md` operational command list; assignments 02 §10 and 05 §11 | Covered after narrowing unavailable model/operation breakdown wording |
| Runtime status — normal; degraded lane | `packages/app/src/observability.ts`, `packages/app/src/telegram/commands.ts`, service status inputs | `packages/app/tests/commands.test.ts`; degraded/escaped status assertion added during apply | `README.md` operational command list; assignment 05 §11 | Coverage gap identified: add degraded-status assertion |
| Scraping — funnel/units/errors; zero source | `packages/app/src/observability.ts`, summary in `packages/store/src/repos.ts` | `packages/app/tests/scraper-status.test.ts`, repository-policy hourly-series test | `README.md` operational command list; assignments 02 §10 and 05 §11 | Implementation gap identified: summary units were collected but omitted from Telegram output |
| Safe reports — splitting; escaping | `packages/app/src/telegram/format.ts`, `packages/app/src/observability.ts`, `packages/app/src/telegram/commands.ts`, owner history | `packages/app/tests/telegram-format.test.ts`, `packages/app/tests/scraper-status.test.ts`, `packages/app/tests/commands.test.ts`, `packages/app/tests/owner-message-history.test.ts`, security tests | `README.md` privacy; assignments 05 §11 and 06 §7 | Covered |

## Reconciliations and implementation gaps

Planning was reconciled before runtime edits to match intended current behavior:

1. Owner access administration is approval/revocation; there is no owner rejection command.
2. Failed Telegram artifact delivery is not marked delivered; immediate retry recovery is not part of the current baseline.
3. The current owner usage view guarantees bounded totals and trends, not model/operation breakdown rows.

Apply work is limited to these confirmed gaps:

1. Add a changed-CV-hash cache-miss test.
2. Add explicit degraded/escaped runtime-status coverage.
3. Display already-collected search-unit status in the owner scraping report and update its tests.

## Validation record

- Strict OpenSpec validation: passed.
- TypeScript typecheck: passed.
- Complete deterministic suite: 251 passed, 0 failed.
- PostgreSQL integration suite: not run because neither the process environment nor `.env` configures `JOBSEEKER_TEST_DATABASE_URL`; no unconfigured or non-test database was touched.
