import { mapConcurrent } from '@jobseeker/engine/concurrency';
import { parseSourceKey } from '@jobseeker/engine/contracts';
import { composeApplication } from './composition.ts';
import { config } from './config.ts';
import { missingSearchProfiles } from './career-profile.ts';
import { createMatchingVocabularies } from './matching-vocabularies.ts';
import { createProfileRefreshPorts } from './workflow-adapters.ts';
import { safeErrorMessage } from './security.ts';
import type { refreshUserProfiles } from './profile-refresh.ts';

export async function refreshMissingProfilesAndExit(refresh: typeof refreshUserProfiles): Promise<void> {
  const composition = await composeApplication({ ...config, telegramMode: 'off', engineMode: 'off' });
  try {
    const vocabulary = createMatchingVocabularies({ loadRoleEquivalences: composition.store.loadRoleEquivalences,
      loadIdfVocabulary: composition.store.loadIdfVocabulary, roleTrackTitles: composition.store.roleTrackTitles,
      vacancyTextBatch: composition.store.vacancyTextBatch, replaceRoleEquivalences: composition.store.replaceRoleEquivalences,
      replaceMatchingVocabularies: composition.store.replaceMatchingVocabularies });
    await vocabulary.load();
    const providers = composition.enabledSourceProviderIds.map((id) => composition.sources.getProvider(id)).filter((value) => value !== undefined);
    const ports = createProfileRefreshPorts({ store: composition.store, config, vocabularies: vocabulary });
    const users = await composition.store.approvedUsers(true);
    await mapConcurrent(users, config.userWorkflowConcurrency, async (user) => {
      const cv = await composition.store.getCvSource(user.userId); if (!cv) return;
      const searches: Record<string, unknown> = {};
      for (const provider of providers) searches[provider.id] = await composition.store.getSearchProfile(user.userId, parseSourceKey(provider.id));
      const missing = missingSearchProfiles({ career: await composition.store.getCareerProfile(user.userId), searches }, cv.hash, providers);
      if (!missing.career && missing.platforms.length === 0) return;
      const neededProviders = missing.career ? providers : providers.filter((provider) => missing.platforms.includes(parseSourceKey(provider.id)));
      await refresh({ userId: user.userId, providers: neededProviders, models: composition.ai, model: config.generationModel,
        thinking: config.generationThinking, clusterSimilarity: config.searchClusterSimilarity,
        initialCadenceMinutes: config.unitCadenceFloorMinutes, ports, errorMessage: safeErrorMessage });
    });
  } finally { await composition.close(); }
}
