## Why

Jobseeker's core user and owner behavior is implemented and documented informally, but it has no authoritative OpenSpec capability baseline. Capturing the current behavior as requirements will make future changes reviewable as explicit deltas and reduce drift between the service, tests, and documentation.

## What Changes

- Add a baseline specification for submitting and confirming a CV, deriving a reusable profile, matching vacancies, and delivering relevant vacancies through Telegram.
- Add a baseline specification for generating, validating, caching, and delivering tailored CVs and cover letters.
- Add a baseline specification for Telegram owner access to normal user functionality and operational views of usage, users, service status, and scraping activity.
- Preserve current externally observable behavior; this change documents the system as built rather than introducing a product behavior change.

## Capabilities

### New Capabilities
- `cv-vacancy-matching`: CV intake, confirmation, profile refresh, vacancy matching, scoring, and Telegram delivery.
- `tailored-applications`: On-demand tailored CV and cover-letter generation, evidence safety, caching, and delivery.
- `telegram-administration`: Owner access control and operational reporting for usage, users, runtime status, and scraping activity.

### Modified Capabilities

None.

## Impact

The new baseline covers behavior currently implemented across `packages/app`, `packages/engine`, `packages/store`, `packages/cv`, `packages/sources`, Telegram workflows, PostgreSQL persistence, source extensions, AI providers, and operational documentation. Implementation work should primarily verify requirement coverage and align tests or documentation where gaps are found; it must not intentionally redesign existing behavior.
