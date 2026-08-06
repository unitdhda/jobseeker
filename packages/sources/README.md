# @jobseeker/sources

Reusable vacancy-provider runtime for Jobseeker. Source-specific adapters live in the root application under
`src/vacancies/providers/`; this package contains no built-in board or company catalogue.

- `contract.ts` — search-platform, profile-template, plan, and discovery-result contracts.
- `sources.ts` — empty instance-scoped provider collection and the public `createSourceProvider` factory.
- `context.ts` — explicitly injected limits, tracing, persistence port, and scoped HTTP client.
- `http.ts` — strict URL/SSRF policy, bounded HTTP helpers, structured-vacancy utilities, and listing collector.
- `drivers/api.ts` — reusable paginated JSON listing/detail wrapper.
- `drivers/ats.ts` — reusable grouped Greenhouse, Lever, Ashby, and SmartRecruiters wrapper without customer boards.
- `drivers/company-site.ts` — reusable first-party career-site wrapper supplied with application-owned codecs.
- `drivers/jsonld-board.ts` — reusable enumerating board wrapper for schema.org `JobPosting` detail pages.

Each driver is a thin factory over `createSourceProvider`; drivers own reusable mechanics while concrete IDs, hosts,
customer boards, codecs, and configuration stay in the application.

The package never reads `process.env`, imports PostgreSQL, owns browser state, or registers providers implicitly.
Each `createSources()` collection starts empty. The application constructs providers, registers them with
`setProvider`, and supplies the shared runtime ports. Provider host declarations produce a collection-owned immutable
URL policy; redirects and DNS destinations are validated without process-global host registration.

```ts
import { createSourceProvider, createSources } from '@jobseeker/sources';

const provider = createSourceProvider({
  id: 'example',
  name: 'Example Careers',
  hosts: ['careers.example.com'],
  schema,
  template: () => template,
  discover: async (plan, context) => {
    // Use context.http and context.recordListingCandidate.
    return { searches: plan.searches.length, users: 0, seen: 0, discovered: 0 };
  },
  normalize: async () => new Map(),
});

const sources = createSources(options);
sources.setProvider(provider);
```

Application providers may use the generic subpath exports:

```ts
import { createApiSource } from '@jobseeker/sources/drivers/api';
import { createAtsSource } from '@jobseeker/sources/drivers/ats';
import { createCompanySiteSource } from '@jobseeker/sources/drivers/company-site';
import { createJsonLdBoardSource } from '@jobseeker/sources/drivers/jsonld-board';
```

```bash
bun test packages/sources
```
