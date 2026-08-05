/**
 * Composition shim: configures @jobseeker/sources once and keeps the one orchestration entry that belongs to the
 * app, because it invokes the app's planner. Everything else re-exports so existing importers stay unchanged.
 */
import {
  configureSources, getSearchPlatform, type PlatformDiscoveryResult, type SearchPlan, type UserSearches,
} from '@jobseeker/sources';
import { config } from '../config.ts';
import { errorMessage, trace } from '../observability.ts';
import { planPlatformSearches } from './plan.ts';

configureSources({
  settings: {
    searchNewVacancyLimit: config.searchNewVacancyLimit,
    searchPageBudgetPerPlatform: config.searchPageBudgetPerPlatform,
    hhMaxPages: config.hhMaxPages, hhAreaId: config.hhAreaId,
    hhBrowserDataPath: config.hhBrowserDataPath, hhOperationTimeoutSeconds: config.hhOperationTimeoutSeconds,
    hireHiMaxPages: config.hireHiMaxPages, additionalMaxPages: config.additionalMaxPages,
    playwrightHeadless: config.playwrightHeadless, playwrightChromiumPath: config.playwrightChromiumPath,
    timezone: config.timezone,
    atsBoards: (process.env.ATS_BOARDS ?? '').split(',').map((entry) => entry.trim()).filter(Boolean),
    trudvsemRegion: process.env.TRUDVSEM_REGION?.trim() || undefined,
  },
  trace, errorMessage,
});

export {
  getSearchPlatform, normalizePlatformCandidates, platformSearches, searchPlatformIds,
  type AnyVacancyPlatform, type PlatformDiscoveryResult, type PlatformProfile, type PlatformValidationTemplate,
  type SearchPlatform, type VacancyPlatform,
} from '@jobseeker/sources';

export async function discoverPlatformVacancies(id: string,
  demands: readonly UserSearches<unknown>[], now = Date.now()): Promise<PlatformDiscoveryResult> {
  const platform = getSearchPlatform(id);
  const plan = planPlatformSearches(id, demands,
    { enumerates: platform.enumerates, mergeText: platform.mergeText }, now);
  return platform.discover(plan as SearchPlan<never>);
}
