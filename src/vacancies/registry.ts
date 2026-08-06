/** Application-owned vacancy-source collection and explicit local-provider registration. */
import { createSources } from '@jobseeker/sources';
import { recordListingCandidate } from '../postgres.ts';
import { enabledSourceProviderIds, sourceProviders } from './providers.ts';
import { config } from '../config.ts';
import { errorMessage, trace } from '../observability.ts';

export const sources = createSources({
  limits: {
    searchNewVacancyLimit: config.searchNewVacancyLimit,
    searchPageBudgetPerPlatform: config.searchPageBudgetPerPlatform,
  },
  trace, errorMessage, recordListingCandidate,
});
for (const provider of sourceProviders) sources.setProvider(provider);

export const searchPlatformIds = sources.platformIds;
export { enabledSourceProviderIds };
export const getSearchPlatform = sources.getPlatform;
export const platformSearches = sources.platformSearches;
export const normalizePlatformCandidates = sources.normalize;
export const closeSources = sources.close;

export type {
  AnyVacancyPlatform, PlatformDiscoveryResult, PlatformProfile, PlatformValidationTemplate,
  SearchPlan, SearchPlatform, VacancyPlatform,
} from '@jobseeker/sources';
