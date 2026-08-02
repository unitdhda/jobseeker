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
- `.env` and OAuth JSON mode `0600`; sensitive directories and SQLite files mode `0700`/`0600`;
- encrypted deployment host storage and encrypted backups;
- firewall and SSH access restricted by the operator;
- no Docker socket or unrelated host directory mounted into the service.

Do not deploy if the host cannot provide encrypted storage. The application deliberately does not implement ad-hoc field encryption because SQLite and Flue must share transactional state; encryption is enforced at the storage/backup layer.

## Retention

- Active account data remains until `/delete_me confirm` or operator-authorized removal.
- Original CV uploads and generated PDFs are never persisted.
- Durable score rows contain only user/vacancy identifiers and the numeric score. High-score alert explanations are deleted after successful delivery.
- Completed one-shot Flue conversations are purged after settlement; active conversation state is retained only for crash recovery.
- User deletion removes the authoritative CV source, profiles, scores, pending alert explanations, decisions, applications, usage, settings, CV embeddings, and any unfinished user-scoped Flue history from the active database.
- Encrypted backups are retained for no more than 30 days and then destroyed; deletion therefore propagates when the final pre-deletion backup expires.
- Operational logs are retained for no more than 7 days. `TRACE_VERBOSE` must remain disabled in production and logs must not intentionally contain CV/model bodies.

## Secret rotation

After suspected exposure, rotate the Telegram bot token, revoke/replace OpenAI Codex OAuth credentials, rotate optional source API keys, replace affected SSH credentials, restart the service, and verify that old credentials fail. Never copy secrets into deployment output or incident reports.

## Verification before deployment

Run:

```bash
npm run typecheck
npm test
npm run build
npm audit --omit=dev
```

On a Docker-capable host, also validate Compose, scan the built image, verify listener/firewall state, inspect only file modes (not secret contents), and test an encrypted-backup restore.
