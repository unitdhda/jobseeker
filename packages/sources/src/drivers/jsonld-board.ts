import type { VacancyCandidate, VacancyInput } from '@jobseeker/engine/contracts';
import {
  boardPlatform, normalizeJsonLdCandidate, scrapeJsonLdBoard, type JsonLdBoard,
} from '../boards.ts';
import type { PlatformDiscoveryResult, SearchPlan } from '../contract.ts';
import { createSourceProvider } from '../sources.ts';

async function normalizeIndividually(candidates: VacancyCandidate[],
  normalize: (candidate: VacancyCandidate) => Promise<VacancyInput | null>):
  Promise<Map<string, VacancyInput | null | Error>> {
  const results = new Map<string, VacancyInput | null | Error>();
  for (const candidate of candidates) {
    try { results.set(candidate.sourceId, await normalize(candidate)); }
    catch (error) { results.set(candidate.sourceId, error instanceof Error ? error : new Error(String(error))); }
  }
  return results;
}

function planned<T>(plan: SearchPlan<T>, result: { seen: number; discovered: number }): PlatformDiscoveryResult {
  const users = new Set(plan.searches.flatMap(({ recipients }) => recipients.map(({ userId }) => userId)));
  return { searches: plan.searches.length, users: users.size, ...result };
}

export { boardPlatform, postingMatchesQuery } from '../boards.ts';
export type { BoardEntry, JsonLdBoard } from '../boards.ts';

/** Builds an enumerating server-rendered board provider from listing and schema.org detail codecs. */
export function createJsonLdBoardSource(board: JsonLdBoard, options: { maxPages?: number } = {}) {
  const platform = boardPlatform(board);
  return createSourceProvider({
    ...platform,
    async discover(plan, context) {
      return planned(plan, await scrapeJsonLdBoard(board, plan, context, options.maxPages ?? 1));
    },
    normalize: (candidates, context) => normalizeIndividually(candidates,
      (candidate): Promise<VacancyInput | null> => normalizeJsonLdCandidate(board, candidate, context)),
  });
}
