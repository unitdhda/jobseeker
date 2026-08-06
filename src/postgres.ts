/** Application-owned PostgreSQL store instance. The package itself has no global pool or configuration. */
import type { PoolConfig } from 'pg';
import { createStore } from '@jobseeker/store';
import { config } from './config.ts';
import { safeVacancyUrl } from '@jobseeker/sources';

function poolMaximum(): number {
  const raw = process.env.POSTGRES_POOL_MAX ?? '4';
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 20) {
    throw new Error('POSTGRES_POOL_MAX must be an integer between 1 and 20.');
  }
  return value;
}

function sslConfig(): PoolConfig['ssl'] {
  const mode = process.env.POSTGRES_SSL ?? 'require';
  if (mode === 'disable') return false;
  if (mode === 'require') return { rejectUnauthorized: false };
  if (mode === 'verify-full') {
    const ca = process.env.POSTGRES_CA_CERT?.replaceAll('\\n', '\n');
    if (!ca) throw new Error('POSTGRES_CA_CERT is required when POSTGRES_SSL=verify-full.');
    return { ca, rejectUnauthorized: true };
  }
  throw new Error('POSTGRES_SSL must be disable, require, or verify-full.');
}

export const store = createStore({
  databaseUrl: process.env.DATABASE_URL ?? '',
  poolMax: poolMaximum(),
  ssl: sslConfig(),
  settings: {
    telegramUserId: config.telegramUserId, telegramChatId: config.telegramChatId,
    accessRequestCooldownMinutes: config.accessRequestCooldownMinutes,
    prefilterMaxAgeDays: config.prefilterMaxAgeDays, searchPlatforms: config.searchPlatforms,
    digestMinScore: config.digestMinScore, alertScore: config.alertScore, timezone: config.timezone,
    safeVacancyUrl,
  },
});

export const {
  activeUnitQueries, addSpend, addressableDigestPage, applyDemand, approvedUsers, beginApplication,
  candidatesDueForRefresh, claimForScoring, claimTelegramSession, claimTelegramUpdate, clearSearchProfile,
  closePostgresPool, completeTelegramUpdate, createMatches, deleteTelegramSession, deleteUserData,
  deliveredArtifact, digestVacancies, dueUnits, existingCompiledUnits, exportUserData, failApplication,
  failTelegramUpdate, getCvHash, getCvSource, getDeliverySettings, getScoredVacancy,
  getScoredVacancyByApplyId, getSearchProfile, getTelegramSession, getTelegramUser, getVacancy,
  isApprovedUser, listTelegramUsers, llmUsageSummary, markAlerted, markApplicationDelivered,
  markApplicationReady, markCandidateClosed, markCandidateFailed, markCandidateNormalized, nextUnitDueAt,
  persistenceReady, purgeExpiredVacancies, queuedListings, recordListingCandidate, recordLlmUsageEvent,
  recordUnitRun, recordUsage, releaseClaimedTelegramSession, replaceDigestSnapshot, requestAccess,
  requireApprovedUser, saveCvSource, saveDeliveredArtifact, saveDeliverySettings, saveScore,
  saveSearchProfile, scoredVacanciesByApplyIdPrefix, scraperSummary, searchScoredVacancies,
  setTelegramSession, setUserStatus, skipVacancy, spentToday, touchTelegramUser, transitionMatch,
  unsentHighScoreVacancies, updateClaimedTelegramSession, upsertVacancy, usageInLast24Hours, userUsageSummaries,
  withPostgresAdvisoryLock,
} = store;

export { applicationAgents } from '@jobseeker/store';
export type {
  AlertVacancy, ApplicationArtifact, DeliverySettings, ScoredVacancy, ScraperHour, ScraperSummary,
  TelegramIdentity, TelegramUser, UsageHour, Vacancy, VacancyInput,
} from '@jobseeker/store';
