# Extensions

This directory belongs to the deployment, not to the repository. Nothing in it is tracked except this file: the
application registers no vacancy sources and no extra AI providers by itself, and it has no opinion about which
ones you run.

At startup the service scans this directory (override with `JOBSEEKER_EXTENSIONS`) for ESM modules — single files,
or subdirectories with an `index.*` — and calls each module's default-exported `register(api)`. Every module it
finds must default-export a function; give shared helpers a no-op one.

Everything an extension plugs into arrives through the `api` argument: source and AI provider registration,
startup/shutdown hooks, environment access, the `@jobseeker/sources` toolkit with its generic drivers,
bounded-concurrency helpers, and the optional encrypted blob store. Extensions therefore need no imports from the
application, which is just as well — the workspace packages are bundled into the build and none of them is
published, so they cannot be imported at runtime. Type-only imports are erased on load and stay legal.

## Getting sources

The repository ships reference providers for about nineteen public sources under
[`packages/sources/examples`](../packages/sources/examples). They are files to copy, not a package to import:

```bash
cp -r packages/sources/examples extensions/examples
```

That folder has an `index.ts`, so the loader treats it as one extension and registers every example. To run a
subset instead, copy individual providers next to `toolkit.ts`, `profile.ts`, and `text.ts` and leave `index.ts`
behind — each provider registers itself. Do not do both in one directory, or the examples register twice and fail
on duplicate provider ids.

## Dependencies

Extensions own their runtime dependencies. Create a `package.json` here and install next to the code that needs
it — the examples need `valibot`; a browser driver or vendor SDK belongs here too. The image installs this
directory's manifest if it finds one.

Beware a Bun-specific trap when testing locally: `bun` falls back to its global install cache, so a dependency
missing from `node_modules` can still resolve on your machine and then fail in a clean container. Check with
`bun --no-install` before shipping.

Node ≥ 23.6 loads `.ts` extensions directly via type stripping, so stick to erasable TypeScript syntax — no enums,
namespaces, or parameter properties.

## Backups

Because none of this is tracked, `git` will not restore it. This directory and your environment file are the two
deployment assets you must back up yourself, and neither survives `git clean` or `rsync --delete`.
