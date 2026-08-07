/**
 * Provider composition is extension-owned: the application registers nothing itself. Extensions loaded before the
 * store is composed supply every provider; SEARCH_PLATFORMS then selects which of them discover, defaulting to all
 * of them, while every registered provider stays available for normalization and URL validation.
 */
import { createSourceUrlPolicy } from '@jobseeker/sources';
import { config } from '../config.ts';
import { loadExtensions } from '../extensions.ts';

const extensions = await loadExtensions();

export const sourceProviders = [...extensions.sourceProviders];
export const extensionStartupHooks = extensions.startupHooks;
export const extensionShutdownHooks = extensions.shutdownHooks;
export const extensionAiProviders = extensions.aiProviders;

const availableProviderIds = [...new Set(sourceProviders.map((provider) => provider.id))];
if (availableProviderIds.length !== sourceProviders.length) {
  throw new Error('Two extensions registered source providers with the same id.');
}
const unknownProviderIds = (config.searchPlatforms ?? []).filter((id) => !availableProviderIds.includes(id));
if (unknownProviderIds.length) {
  throw new Error(`Unknown SEARCH_PLATFORMS values: ${unknownProviderIds.join(', ')}`);
}
export const enabledSourceProviderIds = config.searchPlatforms ?? availableProviderIds;
export const sourceUrlPolicy = createSourceUrlPolicy(sourceProviders);
