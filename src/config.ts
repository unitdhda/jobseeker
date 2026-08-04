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

// Model and thinking settings are left blank in .env.example so the operator picks a provider deliberately; a
// blank value therefore has to mean "unset" rather than an empty model identifier that fails at request time.
function modelEnv(name: string, fallback: string): string {
  const raw = process.env[name]?.trim();
  return raw ? raw : fallback;
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

const supportedSearchPlatforms = ['hh', 'habr', 'rabota', 'hirehi', 'geekjob', 'avito', 'trudvsem', 'ats'] as const;
// geekjob, avito and ats are supported but off by default: measured over 24 hours they returned no listings at
// all, geekjob and avito because their boards do not answer the production egress, ats because no board ships by
// default. Name them in SEARCH_PLATFORMS once a probe from the scraping host shows they read something.
const defaultSearchPlatforms: SearchPlatformId[] = ['hh', 'habr', 'rabota', 'hirehi', 'trudvsem'];
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
  hhBrowserDataPath: resolve(process.env.HH_BROWSER_DATA_PATH ?? './data/hh-browser'),
  model: modelEnv('AI_MODEL', 'openai-codex/gpt-5.6-terra'),
  thinkingLevel: thinkingLevelEnv('AI_THINKING_LEVEL', 'high'),
  scoringModel: modelEnv('AI_SCORING_MODEL', 'openai-codex/gpt-5.6-luna'),
  scoringThinkingLevel: thinkingLevelEnv('AI_SCORING_THINKING_LEVEL', 'medium'),
  scoringFallbackModel: modelEnv('AI_SCORING_FALLBACK_MODEL', 'openai/gpt-5.4-mini'),
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
  searchRotationMinutes: integerEnv('SEARCH_ROTATION_MINUTES', 30, 5, 1_440),
  searchNewVacancyLimit: integerEnv('SEARCH_NEW_VACANCY_LIMIT', 10, 1, 1_000),
  // Token overlap, as a percentage, at which two users' searches count as one query and are fetched once.
  // Lower merges more aggressively and broadens each fetch; 100 merges only identical queries.
  searchClusterSimilarity: integerEnv('SEARCH_CLUSTER_SIMILARITY', 60, 0, 100),
  // Vacancies the shared store already holds that are linked to each user per cycle. Zero disables the store source.
  storeLinkLimitPerUser: integerEnv('STORE_LINK_LIMIT_PER_USER', 50, 0, 1_000),
  // How long a vacancy is kept after it stops appearing in searches, and the oldest the store will serve.
  vacancyRetentionDays: integerEnv('VACANCY_RETENTION_DAYS', 30, 7, 365),
  // Rows deleted per retention pass, so one cycle cannot spend itself purging a large backlog.
  vacancyPurgeBatchSize: integerEnv('VACANCY_PURGE_BATCH_SIZE', 500, 0, 20_000),
  normalizationBatchSizePerUser: integerEnv('NORMALIZATION_BATCH_SIZE_PER_USER', 10, 1, 1_000),
  // Best candidates each source is guaranteed per user before leftover slots are filled by score alone.
  // Zero spreads the batch evenly across the configured platforms.
  normalizationPerSourceQuota: integerEnv('NORMALIZATION_PER_SOURCE_QUOTA', 0, 0, 1_000),
  candidatePrefilterBatchSize: integerEnv('CANDIDATE_PREFILTER_BATCH_SIZE', 1_000, 1, 20_000),
  candidateRefreshBatchSize: integerEnv('CANDIDATE_REFRESH_BATCH_SIZE', 2, 0, 1_000),
  candidateRefreshDays: integerEnv('CANDIDATE_REFRESH_DAYS', 7, 1, 365),
  prefilterEnabled: booleanEnv('PREFILTER_ENABLED', true),
  prefilterBatchSize: integerEnv('PREFILTER_BATCH_SIZE', 500, 1, 20_000),
  prefilterMinScore: integerEnv('PREFILTER_MIN_SCORE', 20, 0, 100),
  // An advert older than this is rejected outright, however well it matches: it is almost certainly filled.
  // Measured against the advert's own publication date, which every adapter reads from the source.
  prefilterMaxAgeDays: integerEnv('PREFILTER_MAX_AGE_DAYS', 30, 1, 365),
  prefilterAuditPercent: integerEnv('PREFILTER_AUDIT_PERCENT', 5, 0, 100),
  prefilterAuditSlots: integerEnv('PREFILTER_AUDIT_SLOTS', 1, 0, 100),
  prefilterCalibrationMinLabels: integerEnv('PREFILTER_CALIBRATION_MIN_LABELS', 100, 1, 100_000),
  scoreAgentConcurrencyMin,
  scoreAgentConcurrencyMax,
  userScoreLimitPerCycle: integerEnv('USER_SCORE_LIMIT_PER_CYCLE', 3, 1, 10_000),
  scoreBatchSize: integerEnv('SCORE_BATCH_SIZE', 3, 1, 20),
  scoringBatchTimeoutSeconds: integerEnv('SCORING_BATCH_TIMEOUT_SECONDS', 180, 30, 1_800),
  claudeCliTimeoutSeconds: integerEnv('CLAUDE_CLI_TIMEOUT_SECONDS', 300, 30, 1_800),
  scoringBatchMaxAttempts: integerEnv('SCORING_BATCH_MAX_ATTEMPTS', 3, 1, 5),
  userDailyApplicationLimit: integerEnv('USER_DAILY_APPLICATION_LIMIT', 5, 1, 100),
  // Counted per platform, so three refreshes of the eight default platforms.
  userDailySearchProfileLimit: integerEnv('USER_DAILY_SEARCH_PROFILE_LIMIT', 24, 1, 100),
  maxPendingWorkerJobs: integerEnv('MAX_PENDING_WORKER_JOBS', 100, 1, 1_000),
  userWorkflowConcurrency: integerEnv('USER_WORKFLOW_CONCURRENCY', 5, 1, 20),
  scrapeConcurrency: integerEnv('SCRAPE_CONCURRENCY', 8, 1, 40),
  deliveryConcurrency: integerEnv('DELIVERY_CONCURRENCY', 5, 1, 20),
  accessRequestCooldownMinutes: integerEnv('ACCESS_REQUEST_COOLDOWN_MINUTES', 60, 1, 43_200),
  cvUploadSessionCooldownMinutes: integerEnv('CV_UPLOAD_SESSION_COOLDOWN_MINUTES', 15, 1, 1_440),
  alertScore,
  digestMinScore,
  cycleCron: process.env.CYCLE_CRON ?? '*/30 * * * *',
  timezone: process.env.TIMEZONE ?? 'Europe/Moscow',
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  telegramUserId: process.env.TELEGRAM_USER_ID ?? process.env.TELEGRAM_CHAT_ID,
  runJobs: booleanEnv('RUN_JOBS', true),
  runInitialCycle: booleanEnv('RUN_INITIAL_CYCLE', true),
  telegramMode: telegramModeEnv(),
  telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
  telegramWebhookAsync: booleanEnv('TELEGRAM_WEBHOOK_ASYNC',false),
  backgroundDeliveryAsync: booleanEnv('BACKGROUND_DELIVERY_ASYNC',false),
} as const;
