import type { VacancyInput } from '@jobseeker/engine/contracts';
import { createSourceProvider } from '@jobseeker/sources';
import { habrPlatform, normalizeAdditionalCandidate, scrapeHabr } from './text.ts';

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
