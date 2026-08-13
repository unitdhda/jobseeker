# Deployment extensions

The application ships an extension loader but no built-in concrete vacancy catalogue or extra AI provider.

The loader scans, in deterministic name order:

- top-level `.ts`, `.mts`, `.mjs`, and `.js` modules;
- one `index.*` inside each top-level subdirectory.

Dotfiles, declarations, `node_modules`, and unrelated files are ignored. Every discovered module must default-export `register(api)`. Duplicate source or AI provider IDs fail composition.

The root defaults to `./extensions` and may be overridden with `JOBSEEKER_EXTENSIONS`.

## API

`extension-api.ts` exports the extension types. Runtime values are injected through `JobseekerExtensionApi`:

- source and AI provider registration;
- startup and shutdown hooks;
- frozen environment snapshot;
- scoped logging;
- source toolkit and generic drivers;
- concurrency helpers;
- optional encrypted state.

## Included extension implementations

### `hh/`

Browser-backed hh.ru source with one serialized persistent Chromium context, SSRF-safe navigation, per-operation deadlines, captcha/closed-page handling, publication-date fallbacks, and optional encrypted `browser/hh.tar.gz` state.

The state archive contains only `hh-browser`, excludes caches/crash telemetry, validates every tar path, enforces a 180 MiB limit, and restores through atomic rename.

### `claude-cli/`

Pi-AI provider that runs a local Claude CLI or a private sidecar. It replaces the default system prompt, disables CLI tools, supports effort and JSON schema, parses stream-json NDJSON, and preserves authoritative CLI usage cost.

`sidecar.ts` provides a loopback/private-only HTTP service with bearer authentication, fixed request fields, body/concurrency/time limits, child cleanup, and optional atomically rotated OAuth-file persistence. `/health` exposes status and expiry metadata only.
