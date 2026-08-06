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

// Model choice belongs entirely to the operator: no model identifier is hardcoded anywhere in the app, so an
// unset variable stays undefined and the request path reports which variable is missing when a role is used.
function modelEnv(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw ? raw : undefined;
}

const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
type ThinkingLevel = typeof thinkingLevels[number];
function thinkingLevelEnv(name: string, fallback: ThinkingLevel): ThinkingLevel {
  const raw = process.env[name]?.trim();
  const value = raw ? raw : fallback;
  if (!thinkingLevels.includes(value as ThinkingLevel)) throw new Error(`Invalid ${name}: ${value}`);
  return value as ThinkingLevel;
}

const telegramModes = ['polling', 'webhook', 'off'] as const;
type TelegramMode = typeof telegramModes[number];
function telegramModeEnv(): TelegramMode {
  const explicit = process.env.TELEGRAM_MODE;
  const value = explicit ?? (booleanEnv('TELEGRAM_POLLING', true) ? 'polling' : 'off');
  if (!telegramModes.includes(value as TelegramMode)) throw new Error(`Invalid TELEGRAM_MODE: ${value}`);
  return value as TelegramMode;
}

// Optional adapters stay off by default until production-egress probes show useful listings. This parser owns only
// operator intent; the provider composition validates requested ids against what was actually registered.
const defaultSearchPlatforms = ['hh', 'habr', 'rabota', 'hirehi', 'trudvsem', 'ozon', 'rwb'];
function platformEnv(): string[] {
  const requested = (process.env.SEARCH_PLATFORMS ?? defaultSearchPlatforms.join(','))
    .split(',').map((value) => value.trim()).filter(Boolean);
  if (!requested.length) throw new Error('SEARCH_PLATFORMS must contain at least one platform.');
  return [...new Set(requested)];
}

const digestMinScore = integerEnv('DIGEST_MIN_SCORE', 50, 0, 99);
const alertScore = integerEnv('ALERT_SCORE', 80, 1, 100);
if (digestMinScore >= alertScore) throw new Error('DIGEST_MIN_SCORE must be lower than ALERT_SCORE.');
// One counter, two thresholds: the first N deliveries of the day carry a tailored CV, and up to the second limit
// a cover letter is still written on its own. The letter is the part a person actually sends, and the PDF is the
// expensive half, so running out of documents should not mean running out of applications.
const userDailyApplicationLimit = integerEnv('USER_DAILY_APPLICATION_LIMIT', 5, 1, 100);
const userDailyCoverLetterLimit = integerEnv('USER_DAILY_COVER_LETTER_LIMIT', 20, 1, 500);
if (userDailyCoverLetterLimit < userDailyApplicationLimit) {
  throw new Error('USER_DAILY_COVER_LETTER_LIMIT must not be lower than USER_DAILY_APPLICATION_LIMIT.');
}
const scoreAgentConcurrencyMin = integerEnv('SCORE_AGENT_CONCURRENCY_MIN', 5, 1, 10);
const scoreAgentConcurrencyMax = integerEnv('SCORE_AGENT_CONCURRENCY_MAX', 10, 1, 20);
if (scoreAgentConcurrencyMin > scoreAgentConcurrencyMax) {
  throw new Error('SCORE_AGENT_CONCURRENCY_MIN must not exceed SCORE_AGENT_CONCURRENCY_MAX.');
}

export const config = {
  hhBrowserDataPath: resolve(process.env.HH_BROWSER_DATA_PATH ?? './data/hh-browser'),
  model: modelEnv('AI_MODEL'),
  thinkingLevel: thinkingLevelEnv('AI_THINKING_LEVEL', 'high'),
  scoringModel: modelEnv('AI_SCORING_MODEL'),
  scoringThinkingLevel: thinkingLevelEnv('AI_SCORING_THINKING_LEVEL', 'medium'),
  scoringFallbackModel: modelEnv('AI_SCORING_FALLBACK_MODEL'),
  scoringFallbackThinkingLevel: thinkingLevelEnv('AI_SCORING_FALLBACK_THINKING_LEVEL', 'medium'),
  hhAreaId: process.env.HH_AREA_ID ?? '1',
  playwrightChromiumPath: process.env.PLAYWRIGHT_CHROMIUM_PATH,
  playwrightHeadless: booleanEnv('PLAYWRIGHT_HEADLESS', true),
  searchPlatforms: platformEnv(),
  hhMaxPages: integerEnv('HH_MAX_PAGES', 1, 1, 20),
  hhOperationTimeoutSeconds: integerEnv('HH_OPERATION_TIMEOUT_SECONDS', 180, 30, 1_800),
  additionalMaxPages: integerEnv('ADDITIONAL_MAX_PAGES', 1, 1, 20),
  hireHiMaxPages: integerEnv('HIREHI_MAX_PAGES', 1, 1, 20),
  searchPageBudgetPerPlatform: integerEnv('SEARCH_PAGE_BUDGET_PER_PLATFORM', 12, 3, 100),
  searchQueriesPerCycle: integerEnv('SEARCH_QUERIES_PER_CYCLE', 1, 1, 8),
  searchNewVacancyLimit: integerEnv('SEARCH_NEW_VACANCY_LIMIT', 10, 1, 1_000),
  // Token overlap, as a percentage, at which two users' searches count as one query and are fetched once.
  // Lower merges more aggressively and broadens each fetch; 100 merges only identical queries.
  searchClusterSimilarity: integerEnv('SEARCH_CLUSTER_SIMILARITY', 60, 0, 100),
  // How long a vacancy is kept after it stops appearing in searches, and the oldest the store will serve.
  vacancyRetentionDays: integerEnv('VACANCY_RETENTION_DAYS', 30, 7, 365),
  // Rows deleted per retention pass, so one cycle cannot spend itself purging a large backlog.
  vacancyPurgeBatchSize: integerEnv('VACANCY_PURGE_BATCH_SIZE', 500, 0, 20_000),
  normalizationBatchSizePerUser: integerEnv('NORMALIZATION_BATCH_SIZE_PER_USER', 10, 1, 1_000),
  candidateRefreshBatchSize: integerEnv('CANDIDATE_REFRESH_BATCH_SIZE', 2, 0, 1_000),
  candidateRefreshDays: integerEnv('CANDIDATE_REFRESH_DAYS', 7, 1, 365),
  prefilterMinScore: integerEnv('PREFILTER_MIN_SCORE', 20, 0, 100),
  // An advert older than this is rejected outright, however well it matches: it is almost certainly filled.
  // Measured against the advert's own publication date, which every adapter reads from the source.
  prefilterMaxAgeDays: integerEnv('PREFILTER_MAX_AGE_DAYS', 30, 1, 365),
  scoreAgentConcurrencyMin,
  scoreAgentConcurrencyMax,
  userScoreLimitPerCycle: integerEnv('USER_SCORE_LIMIT_PER_CYCLE', 3, 1, 10_000),
  // The scoring drain stops claiming for a user once the day's LLM spend from `accounts` reaches this ceiling.
  userDailyLlmBudgetUsd: integerEnv('USER_DAILY_LLM_BUDGET_CENTS', 200, 0, 100_000) / 100,
  unitCadenceFloorMinutes: integerEnv('UNIT_CADENCE_FLOOR_MINUTES', 30, 5, 1_440),
  unitCadenceCeilingMinutes: integerEnv('UNIT_CADENCE_CEILING_MINUTES', 720, 30, 10_080),
  scoreBatchSize: integerEnv('SCORE_BATCH_SIZE', 3, 1, 20),
  scoringBatchTimeoutSeconds: integerEnv('SCORING_BATCH_TIMEOUT_SECONDS', 180, 30, 1_800),
  claudeCliTimeoutSeconds: integerEnv('CLAUDE_CLI_TIMEOUT_SECONDS', 300, 30, 1_800),
  scoringBatchMaxAttempts: integerEnv('SCORING_BATCH_MAX_ATTEMPTS', 3, 1, 5),
  userDailyApplicationLimit,
  userDailyCoverLetterLimit,
  // Counted per platform, so three refreshes of the eight default platforms.
  userDailySearchProfileLimit: integerEnv('USER_DAILY_SEARCH_PROFILE_LIMIT', 24, 1, 100),
  maxPendingWorkerJobs: integerEnv('MAX_PENDING_WORKER_JOBS', 100, 1, 1_000),
  userWorkflowConcurrency: integerEnv('USER_WORKFLOW_CONCURRENCY', 5, 1, 20),
  deliveryConcurrency: integerEnv('DELIVERY_CONCURRENCY', 5, 1, 20),
  accessRequestCooldownMinutes: integerEnv('ACCESS_REQUEST_COOLDOWN_MINUTES', 60, 1, 43_200),
  cvUploadSessionCooldownMinutes: integerEnv('CV_UPLOAD_SESSION_COOLDOWN_MINUTES', 15, 1, 1_440),
  alertScore,
  digestMinScore,
  timezone: process.env.TIMEZONE ?? 'Europe/Moscow',
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  telegramUserId: process.env.TELEGRAM_USER_ID ?? process.env.TELEGRAM_CHAT_ID,
  runJobs: booleanEnv('RUN_JOBS', true),
  telegramMode: telegramModeEnv(),
  telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
  telegramWebhookAsync: booleanEnv('TELEGRAM_WEBHOOK_ASYNC',false),
  backgroundDeliveryAsync: booleanEnv('BACKGROUND_DELIVERY_ASYNC',false),
} as const;
