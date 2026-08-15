## Context

See `proposal.md` for motivation. Vacancies already receive globally unique six-letter lowercase `apply_id` values during normalization. Store reads can already resolve a one-to-six-letter prefix against one user's scored matches and return at most two rows, which distinguishes unique, missing, and ambiguous results.

Telegram currently routes recognized commands and documents but ignores other text. Vacancy rendering is spread across immediate alerts, digest pages, `/search` results, and service-level Telegram transport. Digest rendering computes a shortest prefix only within the digest snapshot, while alerts and search results show the full code without user-history-wide prefix emphasis.

## Goals / Non-Goals

**Goals:**

- Add approved-user non-command text routing without weakening access checks or disturbing command/document/callback behavior.
- Use one user-scoped definition of prefix uniqueness for lookup and every vacancy-bearing message.
- Keep the complete six-letter code visible while emphasizing the shortest currently unique prefix.
- Reuse existing application callbacks and source URLs for the retrieved match card.
- Keep lookup behavior deterministic, localized, and testable outside Telegram network calls.

**Non-Goals:**

- Creating per-match identifiers or changing code allocation.
- Migrating the database schema.
- Making unscored or another user's vacancies addressable.
- Replacing `/search`, alerts, digests, skip actions, or existing application workflows.
- Editing already-sent Telegram messages when later scoring changes prefix uniqueness.

## Decisions

### Reuse the existing global vacancy code

The six-letter `apply_id` remains the only code. A user's match is addressable only through a join to that user's completed score, so global identifier reuse does not grant cross-user visibility.

Alternative considered: assign a separate code to every user–vacancy match. Rejected because it duplicates identity, requires a schema migration, complicates exports and callbacks, and provides no user-visible advantage.

### Normalize and classify text before repository lookup

Approved private non-command text is trimmed and lowercased. Only one through six ASCII letters reach prefix lookup. Invalid normalized input returns the same localized not-found response as an unmatched valid prefix. This avoids unnecessary database work and prevents validation details from becoming an identifier oracle.

Alternative considered: extract a code from arbitrary prose. Rejected because every non-command message is explicitly the lookup input and permissive extraction would make mistakes unpredictable.

### Resolve at most two user-scoped matches

Prefix lookup uses the existing user-scoped scored-match read with a result limit of two:

- zero rows → not found;
- one row → unique match card;
- two rows → ambiguous, request more letters.

No matching codes or match count are included in the ambiguous response.

Alternative considered: return a selection list for ambiguous prefixes. Rejected because the requested behavior is to ask for more letters and because listing candidates would expose more match history than necessary.

### Compute emphasis against the complete scored history snapshot

Rendering obtains all six-letter codes from the requesting user's scored-match history once per message-producing operation or delivery batch. A pure helper computes the shortest prefix for each displayed code against that complete snapshot and renders `<b>{unique-prefix}</b>{remaining-suffix}` with HTML escaping and strict code validation.

The complete suffix remains visible. If a later score makes the old bold prefix ambiguous, the user can still send more letters or the complete code from the old message.

Alternative considered: compute uniqueness only within the current digest page or result set. Rejected because a displayed prefix could resolve ambiguously against the user's wider scored history.

Alternative considered: show only the shortest prefix. Rejected because future matches can change uniqueness after Telegram messages have been sent.

### Centralize vacancy-code formatting inputs

Alert, digest, `/search`, and retrieved-card formatters receive a prefix map or scored-code snapshot rather than independently deciding uniqueness. Delivery paths load the snapshot once per user batch; command and direct-lookup paths load it once per request. This avoids one lookup per displayed vacancy and keeps formatting consistent.

Alternative considered: let each formatter query persistence. Rejected because pure formatting is easier to test and prevents persistence concerns from entering presentation helpers.

### Add a dedicated approved-text route

Telegram routing gains a separate approved non-command text handler with user, locale, message text, and a reply transport capable of attaching inline actions. Authorization and identity touch happen before invocation using the same approved-user rules as ordinary protected commands. Unknown or unapproved arbitrary senders retain current behavior.

Recognized commands continue to use command handlers; documents are intercepted by the existing document route; callbacks and non-text media remain unchanged.

Alternative considered: introduce a `/match` command. Rejected because the requested interaction is command-free text lookup.

### Reuse application callback contracts

A unique card contains the formatted full code, score, title, and employer. Its inline keyboard has exactly three localized buttons in this order:

1. Open — source vacancy URL;
2. Letter — existing `apply:letter:<vacancy-id>` callback;
3. CV — existing `apply:cv:<vacancy-id>` callback.

The callback layer remains responsible for rechecking approval and invoking workflow locks, caching, limits, generation, and delivery.

Alternative considered: generate artifacts directly from the text handler. Rejected because that would bypass established authorization and workflow safeguards.

### Extend the typed locale catalogue

Add typed Russian and English strings/functions for code-not-found, ambiguous-prefix guidance, retrieved-card presentation where needed, and the three button labels. Existing locale parity tests remain the enforcement point.

Alternative considered: hard-code English button and error text as some current service paths do. Rejected because lookup feedback is required to follow the user's locale.

## Risks / Trade-offs

- [Loading all scored codes grows with user history] → Load once per operation, return only identifiers, and preserve a repository boundary so computation can move into SQL later without changing behavior.
- [A prefix displayed in an old message later becomes ambiguous] → Always display the entire six-letter code and bold only the prefix that was unique at render time.
- [Generic chat text now produces not-found replies for approved users] → This is intentional under the “every non-command text” contract; commands and media retain their existing routes.
- [Prefix formatting diverges across message types] → Use one validated pure helper and require the same complete user-history snapshot in alert, digest, search, and retrieval tests.
- [Lookup leaks another user's match] → Keep user ID and completed-score predicates mandatory in both prefix and code-snapshot repository reads.
- [Inline actions bypass workflow safety] → Reuse existing callback payloads and callback authorization rather than calling generation directly.

## Migration Plan

1. Add repository access for the requesting user's complete scored-code snapshot, reusing the existing prefix resolver for unique lookup.
2. Add pure normalization, uniqueness, and full-code emphasis helpers with collision and future-collision tests.
3. Extend Telegram routing and locale catalogues for approved non-command text.
4. Add the retrieval card and wire its three actions to existing URL/callback contracts.
5. Update alerts, digests, `/search`, and retrieval rendering to use user-history-wide prefix emphasis.
6. Run typecheck, deterministic tests, strict OpenSpec validation, and PostgreSQL integration tests when a dedicated test database is configured.

No data migration is required. Rollback removes the text route and formatting integration; existing six-letter codes and callbacks remain valid.
