import type { VacancyInput } from '@jobseeker/engine/contracts';

import { habrPlatform, normalizeAdditionalCandidate, scrapeHabr } from './text.ts';
import { createSourceProvider, examplePages, initToolkit, type SourceExtensionApi } from './toolkit.ts';

export { habrListings, textSearchProfileSchema } from './text.ts';

export function habrSource(options: { maxPages?: number } = {}) {
  return createSourceProvider({
    ...habrPlatform,
    async discover(plan, context) {
      const result = await scrapeHabr(plan, context, options.maxPages ?? 1);
      const users = new Set(plan.searches.flatMap(({ recipients }) => recipients.map(({ userId }) => userId)));
      return { searches: plan.searches.length, users: users.size, ...result };
    },
    async normalize(candidates, context) {
      const results = new Map<string, VacancyInput | null | Error>();
      for (const candidate of candidates) {
        try { results.set(candidate.sourceId, await normalizeAdditionalCandidate(candidate, context)); }
        catch (error) { results.set(candidate.sourceId, error instanceof Error ? error : new Error(String(error))); }
      }
      return results;
    },
  });
}

/** Registers this example; the loader calls it once the file sits in an extensions directory. */
export default function register(api: SourceExtensionApi): void {
  initToolkit(api);
  api.registerSourceProvider(habrSource({ maxPages: examplePages(api) }));
}
