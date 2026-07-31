import { resolve } from 'node:path';

function integerEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be true or false.`);
}

const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
type ThinkingLevel = typeof thinkingLevels[number];
function thinkingLevelEnv(): ThinkingLevel {
  const value = process.env.FLUE_THINKING_LEVEL ?? 'high';
  if (!thinkingLevels.includes(value as ThinkingLevel)) throw new Error(`Invalid FLUE_THINKING_LEVEL: ${value}`);
  return value as ThinkingLevel;
}

const supportedSearchPlatforms = ['hh', 'hirehi', 'habr', 'getmatch', 'geekjob', 'superjob', 'avito', 'rabota'] as const;
const defaultSearchPlatforms = supportedSearchPlatforms.filter((platform) => platform !== 'superjob');
type SearchPlatformId = typeof supportedSearchPlatforms[number];

function platformEnv(): SearchPlatformId[] {
  const requested = (process.env.SEARCH_PLATFORMS ?? defaultSearchPlatforms.join(','))
    .split(',').map((value) => value.trim()).filter(Boolean);
  const unknown = requested.filter((value) => !supportedSearchPlatforms.includes(value as SearchPlatformId));
  if (unknown.length) throw new Error(`Unknown SEARCH_PLATFORMS values: ${unknown.join(', ')}`);
  if (!requested.length) throw new Error('SEARCH_PLATFORMS must contain at least one platform.');
  return [...new Set(requested)] as SearchPlatformId[];
}

const digestMinScore = integerEnv('DIGEST_MIN_SCORE', 50, 0, 99);
const alertScore = integerEnv('ALERT_SCORE', 80, 1, 100);
if (digestMinScore >= alertScore) throw new Error('DIGEST_MIN_SCORE must be lower than ALERT_SCORE.');
const scoreAgentConcurrencyMin = integerEnv('SCORE_AGENT_CONCURRENCY_MIN', 5, 1, 10);
const scoreAgentConcurrencyMax = integerEnv('SCORE_AGENT_CONCURRENCY_MAX', 10, 1, 20);
if (scoreAgentConcurrencyMin > scoreAgentConcurrencyMax) {
  throw new Error('SCORE_AGENT_CONCURRENCY_MIN must not exceed SCORE_AGENT_CONCURRENCY_MAX.');
}

export const config = {
  databasePath: resolve(process.env.DATABASE_PATH ?? './data/jobseeker.db'),
  model: process.env.FLUE_MODEL ?? 'openai-codex/gpt-5.6-terra',
  thinkingLevel: thinkingLevelEnv(),
  hhAreaId: process.env.HH_AREA_ID ?? '1',
  playwrightChromiumPath: process.env.PLAYWRIGHT_CHROMIUM_PATH,
  playwrightHeadless: booleanEnv('PLAYWRIGHT_HEADLESS', true),
  searchPlatforms: platformEnv(),
  hhMaxPages: integerEnv('HH_MAX_PAGES', 2, 1, 20),
  hireHiMaxPages: integerEnv('HIREHI_MAX_PAGES', 1, 1, 20),
  additionalMaxPages: integerEnv('ADDITIONAL_MAX_PAGES', 1, 1, 20),
  getmatchMaxCandidates: integerEnv('GETMATCH_MAX_CANDIDATES', 100, 1, 5_000),
  normalizationBatchSize: integerEnv('NORMALIZATION_BATCH_SIZE', 50, 1, 1_000),
  candidatePrefilterBatchSize: integerEnv('CANDIDATE_PREFILTER_BATCH_SIZE', 1_000, 1, 20_000),
  candidateRefreshBatchSize: integerEnv('CANDIDATE_REFRESH_BATCH_SIZE', 2, 0, 1_000),
  candidateRefreshDays: integerEnv('CANDIDATE_REFRESH_DAYS', 7, 1, 365),
  prefilterEnabled: booleanEnv('PREFILTER_ENABLED', true),
  prefilterBatchSize: integerEnv('PREFILTER_BATCH_SIZE', 500, 1, 20_000),
  prefilterMinScore: integerEnv('PREFILTER_MIN_SCORE', 20, 0, 100),
  prefilterAuditPercent: integerEnv('PREFILTER_AUDIT_PERCENT', 5, 0, 100),
  prefilterAuditSlots: integerEnv('PREFILTER_AUDIT_SLOTS', 1, 0, 100),
  prefilterCalibrationMinLabels: integerEnv('PREFILTER_CALIBRATION_MIN_LABELS', 100, 1, 100_000),
  semanticPrefilterEnabled: booleanEnv('SEMANTIC_PREFILTER_ENABLED', true),
  semanticEmbeddingModel: process.env.SEMANTIC_EMBEDDING_MODEL ?? 'Xenova/multilingual-e5-small',
  semanticEmbeddingDtype: process.env.SEMANTIC_EMBEDDING_DTYPE ?? 'q8',
  semanticEmbeddingCacheDirectory: resolve(process.env.SEMANTIC_EMBEDDING_CACHE_DIRECTORY ?? './data/models'),
  avitoRegion: process.env.AVITO_REGION ?? 'moskva',
  superJobApiKey: process.env.SUPERJOB_API_KEY,
  superJobTownId: integerEnv('SUPERJOB_TOWN_ID', 4, 1, 1_000_000),
  scoreBatchSize: integerEnv('SCORE_BATCH_SIZE', 500, 1, 10_000),
  scoreAgentConcurrencyMin,
  scoreAgentConcurrencyMax,
  userDailyScoreLimit: integerEnv('USER_DAILY_SCORE_LIMIT', 100, 1, 10_000),
  userDailyApplicationLimit: integerEnv('USER_DAILY_APPLICATION_LIMIT', 5, 1, 100),
  userDailySearchProfileLimit: integerEnv('USER_DAILY_SEARCH_PROFILE_LIMIT', 16, 1, 100),
  maxPendingWorkerJobs: integerEnv('MAX_PENDING_WORKER_JOBS', 100, 1, 1_000),
  accessRequestCooldownMinutes: integerEnv('ACCESS_REQUEST_COOLDOWN_MINUTES', 60, 1, 43_200),
  cvUploadSessionCooldownMinutes: integerEnv('CV_UPLOAD_SESSION_COOLDOWN_MINUTES', 15, 1, 1_440),
  alertScore,
  digestMinScore,
  scrapeCron: process.env.SCRAPE_CRON ?? '*/30 * * * *',
  notifyCron: process.env.NOTIFY_CRON ?? '*/30 * * * *',
  digestCron: process.env.DIGEST_CRON ?? '0 9 * * *',
  timezone: process.env.TIMEZONE ?? 'Europe/Moscow',
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  telegramUserId: process.env.TELEGRAM_USER_ID ?? process.env.TELEGRAM_CHAT_ID,
  runJobs: booleanEnv('RUN_JOBS', true),
  runInitialCycle: booleanEnv('RUN_INITIAL_CYCLE', true),
  telegramPolling: booleanEnv('TELEGRAM_POLLING', true),
} as const;
