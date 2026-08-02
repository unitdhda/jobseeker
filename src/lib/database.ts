import type * as Sqlite from './database-sqlite.ts';

export type {
  AccessRequestResult, AlertVacancy, CvSource, DeliverySettings, PrefilterCalibration, PrefilteredVacancy,
  PrefilterScoreInput, ScoredVacancy, TelegramIdentity, TelegramUser, UsageKind, UserStatus, UserUsageSummary,
  Vacancy, VacancyCandidate, VacancyCandidateInput, VacancyInput,
} from './database-sqlite.ts';

type Backend = typeof Sqlite;
type FunctionName = { [K in keyof Backend]: Backend[K] extends (...args: never[]) => unknown ? K : never }[keyof Backend];
type AsyncBackend = { [K in FunctionName]: Backend[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never };
const backend = (process.env.DATABASE_URL ? import('./database-postgres.ts') : import('./database-sqlite.ts')) as unknown as Promise<AsyncBackend>;
const call = async <K extends FunctionName>(name: K, ...args: Parameters<AsyncBackend[K]>): Promise<Awaited<ReturnType<AsyncBackend[K]>>> =>
  (await backend)[name](...args) as Awaited<ReturnType<AsyncBackend[K]>>;

export const getTelegramUser = (...args: Parameters<AsyncBackend['getTelegramUser']>) => call('getTelegramUser', ...args);
export const isApprovedUser = (...args: Parameters<AsyncBackend['isApprovedUser']>) => call('isApprovedUser', ...args);
export const requireApprovedUser = (...args: Parameters<AsyncBackend['requireApprovedUser']>) => call('requireApprovedUser', ...args);
export const touchTelegramUser = (...args: Parameters<AsyncBackend['touchTelegramUser']>) => call('touchTelegramUser', ...args);
export const requestAccess = (...args: Parameters<AsyncBackend['requestAccess']>) => call('requestAccess', ...args);
export const setUserStatus = (...args: Parameters<AsyncBackend['setUserStatus']>) => call('setUserStatus', ...args);
export const listTelegramUsers = (...args: Parameters<AsyncBackend['listTelegramUsers']>) => call('listTelegramUsers', ...args);
export const approvedUsers = (...args: Parameters<AsyncBackend['approvedUsers']>) => call('approvedUsers', ...args);
export const recordUsage = (...args: Parameters<AsyncBackend['recordUsage']>) => call('recordUsage', ...args);
export const usageInLast24Hours = (...args: Parameters<AsyncBackend['usageInLast24Hours']>) => call('usageInLast24Hours', ...args);
export const userUsageSummaries = (...args: Parameters<AsyncBackend['userUsageSummaries']>) => call('userUsageSummaries', ...args);
export const purgeSettledAgentSession = (...args: Parameters<AsyncBackend['purgeSettledAgentSession']>) => call('purgeSettledAgentSession', ...args);
export const purgeSettledAgentSessions = (...args: Parameters<AsyncBackend['purgeSettledAgentSessions']>) => call('purgeSettledAgentSessions', ...args);
export const deleteUserData = (...args: Parameters<AsyncBackend['deleteUserData']>) => call('deleteUserData', ...args);
export const exportUserData = (...args: Parameters<AsyncBackend['exportUserData']>) => call('exportUserData', ...args);
export const getCvSource = (...args: Parameters<AsyncBackend['getCvSource']>) => call('getCvSource', ...args);
export const getCvHash = (...args: Parameters<AsyncBackend['getCvHash']>) => call('getCvHash', ...args);
export const saveCvSource = (...args: Parameters<AsyncBackend['saveCvSource']>) => call('saveCvSource', ...args);
export const saveSearchProfile = (...args: Parameters<AsyncBackend['saveSearchProfile']>) => call('saveSearchProfile', ...args);
export const clearSearchProfile = (...args: Parameters<AsyncBackend['clearSearchProfile']>) => call('clearSearchProfile', ...args);
export async function getSearchProfile<T>(userId: string, platform: string): Promise<T | null> {
  const selected = await backend as unknown as { getSearchProfile<U>(userId: string, platform: string): Promise<U | null> };
  return selected.getSearchProfile<T>(userId, platform);
}
export const getDeliverySettings = (...args: Parameters<AsyncBackend['getDeliverySettings']>) => call('getDeliverySettings', ...args);
export const saveDeliverySettings = (...args: Parameters<AsyncBackend['saveDeliverySettings']>) => call('saveDeliverySettings', ...args);
export const markDigestRun = (...args: Parameters<AsyncBackend['markDigestRun']>) => call('markDigestRun', ...args);
export const upsertVacancy = (...args: Parameters<AsyncBackend['upsertVacancy']>) => call('upsertVacancy', ...args);
export const hasVacancySourceId = (...args: Parameters<AsyncBackend['hasVacancySourceId']>) => call('hasVacancySourceId', ...args);
export const recordVacancyCandidate = (...args: Parameters<AsyncBackend['recordVacancyCandidate']>) => call('recordVacancyCandidate', ...args);
export const candidatesNeedingPrefilter = (...args: Parameters<AsyncBackend['candidatesNeedingPrefilter']>) => call('candidatesNeedingPrefilter', ...args);
export const saveCandidatePrefilter = (...args: Parameters<AsyncBackend['saveCandidatePrefilter']>) => call('saveCandidatePrefilter', ...args);
export const rankedCandidateQueueForUsers = (...args: Parameters<AsyncBackend['rankedCandidateQueueForUsers']>) => call('rankedCandidateQueueForUsers', ...args);
export const candidatesDueForRefresh = (...args: Parameters<AsyncBackend['candidatesDueForRefresh']>) => call('candidatesDueForRefresh', ...args);
export const markCandidateNormalized = (...args: Parameters<AsyncBackend['markCandidateNormalized']>) => call('markCandidateNormalized', ...args);
export const markCandidateClosed = (...args: Parameters<AsyncBackend['markCandidateClosed']>) => call('markCandidateClosed', ...args);
export const markCandidateFailed = (...args: Parameters<AsyncBackend['markCandidateFailed']>) => call('markCandidateFailed', ...args);
export const getVacancy = (...args: Parameters<AsyncBackend['getVacancy']>) => call('getVacancy', ...args);
export const pendingVacancies = (...args: Parameters<AsyncBackend['pendingVacancies']>) => call('pendingVacancies', ...args);
export const vacanciesNeedingPrefilter = (...args: Parameters<AsyncBackend['vacanciesNeedingPrefilter']>) => call('vacanciesNeedingPrefilter', ...args);
export const getCachedEmbedding = (...args: Parameters<AsyncBackend['getCachedEmbedding']>) => call('getCachedEmbedding', ...args);
export const saveCachedEmbedding = (...args: Parameters<AsyncBackend['saveCachedEmbedding']>) => call('saveCachedEmbedding', ...args);
export const savePrefilterScore = (...args: Parameters<AsyncBackend['savePrefilterScore']>) => call('savePrefilterScore', ...args);
export const rankedPendingVacancies = (...args: Parameters<AsyncBackend['rankedPendingVacancies']>) => call('rankedPendingVacancies', ...args);
export const prefilterQueueStats = (...args: Parameters<AsyncBackend['prefilterQueueStats']>) => call('prefilterQueueStats', ...args);
export const prefilterCalibration = (...args: Parameters<AsyncBackend['prefilterCalibration']>) => call('prefilterCalibration', ...args);
export const saveScore = (...args: Parameters<AsyncBackend['saveScore']>) => call('saveScore', ...args);
export const getScoredVacancy = (...args: Parameters<AsyncBackend['getScoredVacancy']>) => call('getScoredVacancy', ...args);
export const getScoredVacancyByApplyId = (...args: Parameters<AsyncBackend['getScoredVacancyByApplyId']>) => call('getScoredVacancyByApplyId', ...args);
export const searchScoredVacancies = (...args: Parameters<AsyncBackend['searchScoredVacancies']>) => call('searchScoredVacancies', ...args);
export const latestDigestVacanciesByApplyIdPrefix = (...args: Parameters<AsyncBackend['latestDigestVacanciesByApplyIdPrefix']>) => call('latestDigestVacanciesByApplyIdPrefix', ...args);
export const digestVacancies = (...args: Parameters<AsyncBackend['digestVacancies']>) => call('digestVacancies', ...args);
export const unsentHighScoreVacancies = (...args: Parameters<AsyncBackend['unsentHighScoreVacancies']>) => call('unsentHighScoreVacancies', ...args);
export const markAlerted = (...args: Parameters<AsyncBackend['markAlerted']>) => call('markAlerted', ...args);
export const markDigested = (...args: Parameters<AsyncBackend['markDigested']>) => call('markDigested', ...args);
export const skipVacancy = (...args: Parameters<AsyncBackend['skipVacancy']>) => call('skipVacancy', ...args);
export const beginApplication = (...args: Parameters<AsyncBackend['beginApplication']>) => call('beginApplication', ...args);
export const markApplicationReady = (...args: Parameters<AsyncBackend['markApplicationReady']>) => call('markApplicationReady', ...args);
export const markApplicationDelivered = (...args: Parameters<AsyncBackend['markApplicationDelivered']>) => call('markApplicationDelivered', ...args);
export const failApplication = (...args: Parameters<AsyncBackend['failApplication']>) => call('failApplication', ...args);
