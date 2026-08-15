## 1. Establish Conformance Evidence

- [x] 1.1 Map every `cv-vacancy-matching` requirement and scenario to its current implementation, deterministic tests, and user-facing documentation; record any unsupported or ambiguous scenario before editing code.
- [x] 1.2 Map every `tailored-applications` requirement and scenario to its current implementation, deterministic tests, and user-facing documentation; record any unsupported or ambiguous scenario before editing code.
- [x] 1.3 Map every `telegram-administration` requirement and scenario to its current implementation, deterministic tests, and operational documentation; record any unsupported or ambiguous scenario before editing code.
- [x] 1.4 Reconcile any requirement that does not describe intended current behavior through an explicit planning-artifact update before treating it as implementation work.

## 2. Verify CV-to-Vacancy Behavior

- [x] 2.1 Run and review the existing CV extraction, preview, confirmation, profile-refresh, matching, scoring, and delivery tests that provide evidence for `cv-vacancy-matching`.
- [x] 2.2 Add or strengthen focused tests for any CV intake, profile isolation, threshold delivery, failed-delivery, or delivered-wall scenario not already proven at an observable boundary.
- [x] 2.3 Correct only confirmed implementation or documentation gaps needed to align current intended CV-to-vacancy behavior with the baseline.

## 3. Verify Tailored Application Behavior

- [x] 3.1 Run and review the existing application-schema, CV-evidence, rendering, workflow-lock, artifact-cache, Telegram-action, and delivery tests that provide evidence for `tailored-applications`.
- [x] 3.2 Add or strengthen focused tests for independent artifact requests and limits, evidence rejection, same-CV cache reuse, changed-CV regeneration, failed delivery, and PDF-byte non-retention where coverage is missing.
- [x] 3.3 Correct only confirmed implementation or documentation gaps needed to align current intended tailored-application behavior with the baseline.

## 4. Verify Telegram Administration Behavior

- [x] 4.1 Run and review the existing access-control, command, usage-chart, scraper-status, runtime-status, formatting, and owner-message-history tests that provide evidence for `telegram-administration`.
- [x] 4.2 Add or strengthen focused tests for owner protection, non-owner denial, empty usage, zero-activity sources, degraded subsystem reporting, safe message splitting, and user-content escaping where coverage is missing.
- [x] 4.3 Correct only confirmed implementation or documentation gaps needed to align current intended owner behavior with the baseline, preserving redaction and bounded output.

## 5. Documentation and Validation

- [x] 5.1 Verify `README.md`, package documentation, and `docs/implementation-from-scratch/` describe behavior consistently with all three capabilities; make only necessary alignment edits.
- [x] 5.2 Run `openspec validate document-current-jobseeker-capabilities --strict` and resolve all proposal/spec/design/task validation errors.
- [x] 5.3 Run `bun run typecheck` and the complete deterministic `bun run test` suite, resolving regressions without broadening scope.
- [x] 5.4 Run the dedicated PostgreSQL integration suite when an explicitly configured safe test database is available, or document why that optional environment-dependent gate was not run.
- [x] 5.5 Review the final diff to confirm there is no database migration, product redesign, secret exposure, or unrelated code churn.
