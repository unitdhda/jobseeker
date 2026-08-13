# `@jobseeker/store`

The only runtime persistence package. It owns PostgreSQL connections and named repositories; settings and security policy are injected explicitly.

```ts
import { createStore } from '@jobseeker/store';

const store = createStore({
  databaseUrl,
  poolMax: 10,
  ssl,
  settings,
});
```

## Runtime ownership

- Store construction does not create a pool.
- The first SQL operation creates that store instance's bounded pool.
- Repository calls are bound to their owning instance through `AsyncLocalStorage`.
- Transactions, advisory locks, and singleton session locks retain one PostgreSQL connection for their full lifetime.
- `close()` is idempotent and releases pooled and dedicated singleton connections.

`store.admin` exposes raw query/transaction/pool access only for application-owned initialization and integration work. Normal app runtime modules must use named repositories.

## Schema

`packages/app/schema.sql` is the complete schema for a fresh database. It is not a migration series.

## PostgreSQL integration test

Set a dedicated database whose name contains `test`:

```sh
JOBSEEKER_TEST_DATABASE_URL=postgres://.../jobseeker_test bun run test:postgres
```

Set `JOBSEEKER_TEST_DATABASE_SSL=1` for TLS-required hosts. If a controlled test environment uses a certificate chain unavailable to the local trust store, `JOBSEEKER_TEST_DATABASE_TLS_INSECURE=1` keeps transport encrypted but disables certificate verification for that test run only.

The test creates and drops a unique temporary schema containing the complete schema; a single test table is insufficient for repository lifecycle and constraint validation. It refuses a database name without `test` unless `JOBSEEKER_ALLOW_DESTRUCTIVE_POSTGRES_TEST=1` is explicitly set.
