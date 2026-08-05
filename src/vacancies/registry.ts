/**
 * Composition shim: configures @jobseeker/sources once and keeps the one orchestration entry that belongs to the
 * app, because it invokes the app's planner. Everything else re-exports so existing importers stay unchanged.
 */
import { configureSources } from '@jobseeker/sources';
import { config } from '../config.ts';
import { errorMessage, trace } from '../observability.ts';

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
  type SearchPlan, type SearchPlatform, type VacancyPlatform,
} from '@jobseeker/sources';
