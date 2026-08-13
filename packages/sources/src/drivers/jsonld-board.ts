import type { VacancyCandidate, VacancyInput } from '@jobseeker/engine/contracts';
import type { PlatformDiscoveryResult, SearchPlan } from '../contract.ts';
import type { BoardSearch, JsonLdBoard } from '../boards.ts';
import { boardPlatform, normalizeJsonLdCandidate, postingMatchesQuery, scrapeJsonLdBoard } from '../boards.ts';
import { createSourceProvider } from '../sources.ts';

export { boardPlatform, postingMatchesQuery } from '../boards.ts';
export type { BoardEntry, BoardSearch, BoardSearchProfile, JsonLdBoard } from '../boards.ts';
export { boardSearchProfileSchema, normalizeJsonLdCandidate, scrapeJsonLdBoard } from '../boards.ts';

async function normalizeIndividually(
  candidates: readonly VacancyCandidate[], normalize: (candidate: VacancyCandidate) => Promise<VacancyInput | null>,
): Promise<Map<string, VacancyInput | null | Error>> {
  const results = new Map<string, VacancyInput | null | Error>();
  await Promise.all(candidates.map(async (candidate) => {
    try { results.set(candidate.sourceId, await normalize(candidate)); }
    catch (error) { results.set(candidate.sourceId, error instanceof Error ? error : new Error(String(error))); }
  }));
  return results;
}

function planned<T>(plan: SearchPlan<T>, result: { readonly seen: number; readonly discovered: number;
  readonly discoveredBySearch?: Readonly<Record<string, number>> }): PlatformDiscoveryResult {
  const users = new Set(plan.searches.flatMap(({ recipients }) => recipients.map(({ userId }) => userId)));
  return Object.freeze({ searches: plan.searches.length, users: users.size, ...result });
}

export function createJsonLdBoardSource(board: JsonLdBoard, options: { readonly maxPages?: number } = {}) {
  const maxPages = options.maxPages ?? 1;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new RangeError('Invalid JSON-LD board page limit.');
  const platform = boardPlatform(board);
  return createSourceProvider({ ...platform,
    async discover(plan: SearchPlan<BoardSearch>, context) {
      return planned(plan, await scrapeJsonLdBoard(board, plan, context, maxPages));
    },
    normalize: (candidates, context) => normalizeIndividually(candidates,
      (candidate) => normalizeJsonLdCandidate(board, candidate, context)),
  });
}
