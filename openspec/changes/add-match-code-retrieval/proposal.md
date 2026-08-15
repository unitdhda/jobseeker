## Why

Users see short vacancy codes in alerts and digests but cannot retrieve a match simply by sending that code back to the bot. Direct prefix lookup will make returning to a scored match and starting an application faster, without requiring a command or search query.

## What Changes

- Reuse each vacancy's existing globally unique six-letter `applyId` as the scored match code shown to users.
- Treat every non-command private text message from an approved user as a match-code prefix lookup.
- Normalize surrounding whitespace and letter case before lookup.
- Resolve prefixes against all scored matches belonging to the requesting user, accepting any unique prefix from one through six letters.
- In every vacancy-bearing Telegram message, show the full six-letter code and bold only its shortest prefix that is unique across the user's scored history.
- Return a localized not-found response for an invalid or unmatched code and an ambiguity response when multiple match codes share the prefix.
- For a unique result, send the vacancy score, title, and employer with exactly three actions: open the source vacancy, generate a cover letter, or generate a tailored CV.
- Preserve existing command, callback, CV-document, and non-text media behavior.

## Capabilities

### New Capabilities
- `match-code-retrieval`: User-scoped scored-match lookup by normalized unique `applyId` prefix and presentation of direct vacancy/application actions.

### Modified Capabilities

None.

## Impact

The change affects Telegram text routing and localization, scored-vacancy prefix lookup integration, match-card formatting, and callback reuse for existing application generation. The existing vacancy `apply_id`, scoring records, source URL, and application callback contracts remain authoritative; no new identifier or database migration is required.
