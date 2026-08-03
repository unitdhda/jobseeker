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
function thinkingLevelEnv(name: string, fallback: ThinkingLevel): ThinkingLevel {
  const value = process.env[name] ?? fallback;
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

const supportedSearchPlatforms = ['hh', 'habr', 'rabota', 'hirehi'] as const;
const defaultSearchPlatforms: SearchPlatformId[] = [...supportedSearchPlatforms];
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
  model: process.env.AI_MODEL ?? 'openai-codex/gpt-5.6-terra',
  thinkingLevel: thinkingLevelEnv('AI_THINKING_LEVEL', 'high'),
  scoringModel: process.env.AI_SCORING_MODEL ?? 'openai-codex/gpt-5.6-luna',
  scoringThinkingLevel: thinkingLevelEnv('AI_SCORING_THINKING_LEVEL', 'medium'),
  scoringFallbackModel: process.env.AI_SCORING_FALLBACK_MODEL ?? 'openai/gpt-5.4-mini',
  scoringFallbackThinkingLevel: thinkingLevelEnv('AI_SCORING_FALLBACK_THINKING_LEVEL', 'medium'),
  hhAreaId: process.env.HH_AREA_ID ?? '1',
  playwrightChromiumPath: process.env.PLAYWRIGHT_CHROMIUM_PATH,
  playwrightHeadless: booleanEnv('PLAYWRIGHT_HEADLESS', true),
  searchPlatforms: platformEnv(),
  hhMaxPages: integerEnv('HH_MAX_PAGES', 5, 1, 20),
  additionalMaxPages: integerEnv('ADDITIONAL_MAX_PAGES', 5, 1, 20),
  hireHiMaxPages: integerEnv('HIREHI_MAX_PAGES', 5, 1, 20),
  searchPageBudgetPerPlatform: integerEnv('SEARCH_PAGE_BUDGET_PER_PLATFORM', 12, 3, 100),
  searchNewVacancyLimit: integerEnv('SEARCH_NEW_VACANCY_LIMIT', 10, 1, 1_000),
  normalizationBatchSizePerUser: integerEnv('NORMALIZATION_BATCH_SIZE_PER_USER', 10, 1, 1_000),
  candidatePrefilterBatchSize: integerEnv('CANDIDATE_PREFILTER_BATCH_SIZE', 1_000, 1, 20_000),
  candidateRefreshBatchSize: integerEnv('CANDIDATE_REFRESH_BATCH_SIZE', 2, 0, 1_000),
  candidateRefreshDays: integerEnv('CANDIDATE_REFRESH_DAYS', 7, 1, 365),
  prefilterEnabled: booleanEnv('PREFILTER_ENABLED', true),
  prefilterBatchSize: integerEnv('PREFILTER_BATCH_SIZE', 500, 1, 20_000),
  prefilterMinScore: integerEnv('PREFILTER_MIN_SCORE', 20, 0, 100),
  prefilterAuditPercent: integerEnv('PREFILTER_AUDIT_PERCENT', 5, 0, 100),
  prefilterAuditSlots: integerEnv('PREFILTER_AUDIT_SLOTS', 1, 0, 100),
  prefilterCalibrationMinLabels: integerEnv('PREFILTER_CALIBRATION_MIN_LABELS', 100, 1, 100_000),
  scoreAgentConcurrencyMin,
  scoreAgentConcurrencyMax,
  userScoreLimitPerCycle: integerEnv('USER_SCORE_LIMIT_PER_CYCLE', 3, 1, 10_000),
  scoreBatchSize: integerEnv('SCORE_BATCH_SIZE', 3, 1, 20),
  userDailyApplicationLimit: integerEnv('USER_DAILY_APPLICATION_LIMIT', 5, 1, 100),
  userDailySearchProfileLimit: integerEnv('USER_DAILY_SEARCH_PROFILE_LIMIT', 7, 1, 100),
  maxPendingWorkerJobs: integerEnv('MAX_PENDING_WORKER_JOBS', 100, 1, 1_000),
  userWorkflowConcurrency: integerEnv('USER_WORKFLOW_CONCURRENCY', 3, 1, 20),
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
