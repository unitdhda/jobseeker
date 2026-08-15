## 1. Scored-Code Data Access

- [x] 1.1 Add a user-scoped repository read that returns the complete six-letter code snapshot for all and only that user's scored matches.
- [x] 1.2 Reuse or adapt scored-prefix lookup so it returns at most two user-scoped scored matches for a normalized one-to-six-letter prefix.
- [x] 1.3 Add repository policy and PostgreSQL integration coverage for scored-only filtering, user isolation, unique results, ambiguous results, and unmatched prefixes.

## 2. Code Normalization and Presentation

- [x] 2.1 Add a pure helper that trims and lowercases candidate code text and accepts only one through six ASCII letters.
- [x] 2.2 Extend the unique-prefix helper to format the full six-letter code with only the shortest user-history-unique prefix bold, including one-letter, six-letter, and collision cases.
- [x] 2.3 Update alert, digest, `/search`, and retrieved-card formatters to consume the complete user scored-code snapshot and use the same full-code emphasis helper.
- [x] 2.4 Add formatting tests proving every vacancy-bearing message keeps all six letters visible, escapes content, and uses uniqueness across the complete supplied history rather than only the visible page or result set.

## 3. Telegram Text Routing and Localization

- [x] 3.1 Add typed English and Russian catalogue entries for code-not-found, ambiguous-prefix guidance, retrieved-match presentation, and localized Open, Letter, and CV labels.
- [x] 3.2 Add an approved non-command private-text route that preserves recognized commands, document handling, callbacks, non-text media behavior, and current unknown/unapproved sender behavior.
- [x] 3.3 Add routing tests for approved text, uppercase/whitespace normalization handoff, recognized commands, unknown and unapproved users, documents, and non-text updates.

## 4. Match Retrieval Card

- [x] 4.1 Implement the user-scoped lookup handler with invalid/unmatched, ambiguous, and unique outcomes that disclose no candidate codes or cross-user details.
- [x] 4.2 Render a unique result with formatted full code, score, title, and employer plus exactly three localized buttons ordered Open, Letter, and CV.
- [x] 4.3 Wire Open to the stored source URL and reuse the existing `apply:letter:<id>` and `apply:cv:<id>` callback contracts without bypassing callback authorization or workflow safeguards.
- [x] 4.4 Add handler and service wiring tests for not-found, ambiguous, unique, button order/payloads, localization, and HTML escaping.

## 5. Documentation and Validation

- [x] 5.1 Update user-facing documentation to explain sending any currently unique code prefix and the full-code/bold-prefix notation.
- [x] 5.2 Run `openspec validate add-match-code-retrieval --strict` and resolve all artifact validation errors.
- [x] 5.3 Run targeted Telegram, formatting, delivery, repository, callback, and localization tests.
- [x] 5.4 Run `bun run typecheck` and the complete deterministic `bun run test` suite; run PostgreSQL integration tests when a dedicated safe test database is configured.
- [x] 5.5 Review the final diff to confirm no identifier migration, access-control regression, private match disclosure, or unrelated behavior change.
