# Extensions

The application registers no vacancy sources and no extra AI providers by itself. At startup it scans this
directory (override with `JOBSEEKER_EXTENSIONS`) for ESM modules — single files or subdirectories with an
`index.*` — and calls each module's default-exported `register(api)`.

Everything an extension plugs into arrives through the `api` argument: source and AI provider registration,
startup/shutdown hooks, environment access, the `@jobseeker/sources` toolkit with its generic drivers and example
providers, bounded-concurrency helpers, and the optional encrypted blob store. Extensions therefore need no
imports from the application itself at runtime; type-only imports (erased on load) are fine and
`extension-api.ts` re-exports the api types for them.

Runtime dependencies of extensions (a browser driver, a vendor SDK) are installed here, next to the code that
needs them: `bun install` (or `npm install`) in this directory. Node ≥ 23.6 loads `.ts` extensions directly via
type stripping, so stick to erasable TypeScript syntax — no enums, namespaces, or parameter properties.

Tracked in this repository:

- `examples.ts` — registers every example provider from `@jobseeker/sources`; edit or delete to change the set.
- `hh/` — hh.ru through a persistent Playwright browser: the reference for a source that owns heavy dependencies,
  a lifecycle, and cross-host state.

Anything else in this directory is deployment-local and ignored by git.
