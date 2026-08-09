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
needs them: `bun install` (or `npm install`) in this directory. This directory is not a root workspace, so it
carries its own `bun.lock` and the image installs it with `--frozen-lockfile` — a floating vendor SDK must not
change under a rebuild that was only meant to ship new application code. After editing `package.json`, run
`bun install` here and commit the refreshed lockfile, or the image build will fail loudly rather than resolve
something new. Node ≥ 23.6 loads `.ts` extensions directly via type stripping, so stick to erasable TypeScript
syntax — no enums, namespaces, or parameter properties.

Because the checkout has no `extensions/node_modules` until you install here, `playwright` is also a root
devDependency so that `bun run typecheck` can resolve the `hh/` imports. `tests/package-boundaries.test.ts` keeps
the two declarations on the same version.

Tracked in this repository:

- `package.json` + `bun.lock` — the extension dependency tree, pinned.
- `examples.ts` — registers every example provider from `@jobseeker/sources`; edit or delete to change the set.
- `hh/` — hh.ru through a persistent Playwright browser: the reference for a source that owns heavy dependencies,
  a lifecycle, and cross-host state.

Anything else in this directory is deployment-local and ignored by git.
