/** Application-owned vacancy-source registry. The package itself carries no configured singleton. */
import { createSourceRegistry } from '@jobseeker/sources';
import { recordListingCandidate } from '../postgres.ts';
import { config } from '../config.ts';
import { errorMessage, trace } from '../observability.ts';

export const sources = createSourceRegistry({
  settings: {
    searchNewVacancyLimit: config.searchNewVacancyLimit,
    searchPageBudgetPerPlatform: config.searchPageBudgetPerPlatform,
    hhMaxPages: config.hhMaxPages, hhAreaId: config.hhAreaId,
    hhBrowserDataPath: config.hhBrowserDataPath, hhOperationTimeoutSeconds: config.hhOperationTimeoutSeconds,
    hireHiMaxPages: config.hireHiMaxPages, additionalMaxPages: config.additionalMaxPages,
    playwrightHeadless: config.playwrightHeadless, playwrightChromiumPath: config.playwrightChromiumPath,
    timezone: config.timezone,
    browserEnvironment: {
      lang: process.env.LANG ?? 'C.UTF-8',
      path: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      tmpdir: process.env.TMPDIR ?? '/tmp',
    },
    atsBoards: (process.env.ATS_BOARDS ?? '').split(',').map((entry) => entry.trim()).filter(Boolean),
    trudvsemRegion: process.env.TRUDVSEM_REGION?.trim() || undefined,
  },
  trace, errorMessage, recordListingCandidate,
});

export const searchPlatformIds = sources.platformIds;
export const getSearchPlatform = sources.getPlatform;
export const platformSearches = sources.platformSearches;
export const normalizePlatformCandidates = sources.normalize;
export const closeSources = sources.close;

export type {
  AnyVacancyPlatform, PlatformDiscoveryResult, PlatformProfile, PlatformValidationTemplate,
  SearchPlan, SearchPlatform, VacancyPlatform,
} from '@jobseeker/sources';
