# Security policy

## Reporting

Report suspected vulnerabilities privately to the repository owner. Do not include live Telegram tokens, OAuth JSON, CV content, database copies, or production logs in an issue or chat message. Rotate exposed credentials immediately and preserve only redacted evidence.

## Supported deployment

The supported production topology is the repository's Docker Compose service on a trusted deployment host:

- port 3000 published only on host loopback;
- one active Telegram poller;
- non-root, read-only container with all capabilities dropped and no-new-privileges enabled;
- Chromium sandbox enabled;
- writable mounts limited to `/app/data`, `/app/auth`, and the model cache;
- `.env` and OAuth JSON mode `0600`; sensitive directories mode `0700`;
- encrypted deployment host storage and encrypted backups;
- firewall and SSH access restricted by the operator;
- no Docker socket or unrelated host directory mounted into the service.

Do not deploy if the host cannot provide encrypted storage. Encryption is enforced at the storage and backup layer, so the confidentiality of everything the service holds depends on the host and the database provider being encrypted at rest.

## Retention

- Active account data remains until `/delete_me confirm` or operator-authorized removal.
- Original CV uploads and generated PDFs are never persisted.
- Durable score rows contain only user/vacancy identifiers and the numeric score. High-score alert explanations are deleted after successful delivery.
- User deletion removes the authoritative CV source and its derived documents, matches with their scores, decisions, applications and pending alert explanations, usage records, search-unit subscriptions, and workflow state from the active database, and clears the account's delivery settings, timezone, and language.
- Encrypted backups are retained for no more than 30 days and then destroyed; deletion therefore propagates when the final pre-deletion backup expires.
- Operational logs are retained for no more than 7 days. `TRACE_VERBOSE` must remain disabled in production and logs must not intentionally contain CV/model bodies.

## Secret rotation

After suspected exposure, rotate the Telegram bot token, revoke and replace the AI provider credentials held in the encrypted credential store (`AI_AUTH_FILE`), rotate `RUNTIME_STATE_ENCRYPTION_KEY` and any source API keys, replace affected SSH credentials, restart the service, and verify that old credentials fail. Never copy secrets into deployment output or incident reports.

## Verification before deployment

Run:

```bash
bun run typecheck
bun run test
bun run build
bun run test:postgres
bun audit
```

On a Docker-capable host, also build and scan the runtime image. Inspect only file modes (not secret contents), and test encrypted-state recovery without printing stored data.
