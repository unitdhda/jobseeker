import { parseSourceKey } from '@jobseeker/engine/contracts';
import type { ThinkingLevel } from '@earendil-works/pi-ai';
import type { Locale } from '@jobseeker/store';

export type TelegramMode = 'polling' | 'webhook' | 'off';
export type EngineMode = 'run' | 'off';
export type ModelId = `${string}/${string}`;

export interface AppConfig {
  readonly generationModel?: ModelId;
  readonly generationThinking?: ThinkingLevel;
  readonly scoringModel?: ModelId;
  readonly scoringThinking?: ThinkingLevel;
  readonly prescoringModel?: ModelId;
  readonly prescoringThinking?: ThinkingLevel;
  readonly scoringFallbackModel?: ModelId;
  readonly scoringFallbackThinking?: ThinkingLevel;

  readonly additionalMaxPages: number;
  readonly searchPageBudgetPerPlatform: number;
  readonly searchQueriesPerCycle: number;
  readonly searchNewVacancyLimit: number;
  readonly searchClusterSimilarity: number;
  readonly vacancyRetentionDays: number;
  readonly vacancyPurgeBatchSize: number;
  readonly normalizationBatchSizePerUser: number;
  readonly normalizeSourceConcurrency: number;
  readonly discoveryTickConcurrency: number;
  readonly candidateRefreshBatchSize: number;
  readonly candidateRefreshDays: number;

  readonly prefilterMinScore: number;
  readonly prefilterMaxAgeDays: number;
  readonly prescoreMinScore: number;
  readonly prescoreBatchSize: number;
  readonly prescoreLimitPerCycle: number;
  readonly prescoreExplorationRate: number;
  readonly prescorePromptVersion: string;

  readonly scoreConcurrencyMin: number;
  readonly scoreConcurrencyMax: number;
  readonly scoreBatchSize: number;
  readonly scoringBatchTimeoutMs: number;
  readonly scoringBatchMaxAttempts: number;
  readonly userScoreLimitPerCycle: number;
  readonly userDailyLlmBudgetUsd: number;
  readonly unitCadenceFloorMinutes: number;
  readonly unitCadenceCeilingMinutes: number;

  readonly userDailyApplicationLimit: number;
  readonly userDailyCoverLetterLimit: number;
  readonly userDailySearchProfileLimit: number;
  readonly userWorkflowConcurrency: number;
  readonly deliveryConcurrency: number;
  readonly maxPendingWorkerJobs: number;
  readonly accessRequestCooldownMinutes: number;
  readonly cvUploadSessionCooldownMinutes: number;

  readonly digestMinScore: number;
  readonly alertScore: number;
  readonly timezone: string;
  readonly defaultLocale: Locale;
  readonly ownerTelegramUserId?: string;
  readonly searchPlatforms?: readonly string[];
  readonly engineMode: EngineMode;
  readonly telegramMode: TelegramMode;
  readonly telegramBotToken?: string;
  readonly telegramWebhookUrl?: string;
  readonly telegramWebhookSecret?: string;

  readonly databaseUrl?: string;
  readonly postgresPoolMax: number;
  readonly postgresSsl: 'disable' | 'require' | 'verify-full';
  readonly postgresCaCert?: string;
  readonly appPort: number;
  readonly extensionsPath: string;
  readonly aiAuthFile: string;

  readonly stateStorageUrl?: string;
  readonly stateStorageKey?: string;
  readonly stateStorageBucket?: string;
  readonly runtimeStateEncryptionKey?: string;
}

function optional(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
}

export function parseInteger(value: string | undefined, fallback: number, name: string,
  minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  const text = optional(value);
  if (text === undefined) return fallback;
  if (!/^-?\d+$/u.test(text)) throw new TypeError(`${name} must be an integer.`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

export function parseFraction(value: string | undefined, fallback: number, name: string): number {
  const text = optional(value);
  if (text === undefined) return fallback;
  // Exponents and signs are rejected to keep deployment values visually auditable.
  if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/u.test(text)) throw new TypeError(`${name} must be a decimal fraction from 0 through 1.`);
  return Number(text);
}

export function parseBoolean(value: string | undefined, fallback: boolean, name: string): boolean {
  const text = optional(value)?.toLowerCase();
  if (text === undefined) return fallback;
  if (text === 'true') return true;
  if (text === 'false') return false;
  throw new TypeError(`${name} must be true or false.`);
}

export function parseLocale(value: string | undefined, fallback: Locale): Locale {
  const text = optional(value)?.toLowerCase();
  if (text === undefined) return fallback;
  if (text !== 'ru' && text !== 'en') throw new TypeError('BOT_LOCALE must be ru or en.');
  return text;
}

export function parseModelId(value: string | undefined, name: string): ModelId | undefined {
  const text = optional(value);
  if (text === undefined) return undefined;
  const slash = text.indexOf('/');
  if (slash < 1 || slash === text.length - 1 || !/^[a-zA-Z0-9._-]+$/u.test(text.slice(0, slash))
    || /\s|[\u0000-\u001f\u007f]/u.test(text.slice(slash + 1))) {
    throw new TypeError(`${name} must use provider/model syntax.`);
  }
  return text as ModelId;
}

const thinkingLevels = new Set<ThinkingLevel>(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export function parseThinkingLevel(value: string | undefined, name: string): ThinkingLevel | undefined {
  const text = optional(value)?.toLowerCase();
  if (text === undefined) return undefined;
  if (!thinkingLevels.has(text as ThinkingLevel)) throw new TypeError(`${name} has an unsupported thinking level.`);
  return text as ThinkingLevel;
}

export function parseTelegramMode(value: string | undefined, legacyPolling?: string): TelegramMode {
  const text = optional(value)?.toLowerCase();
  if (text === undefined) return parseBoolean(legacyPolling, true, 'TELEGRAM_POLLING') ? 'polling' : 'off';
  if (text !== 'polling' && text !== 'webhook' && text !== 'off') {
    throw new TypeError('TELEGRAM_MODE must be polling, webhook, or off.');
  }
  return text;
}

export function parsePlatformList(value: string | undefined): readonly string[] | undefined {
  const text = optional(value);
  if (text === undefined) return undefined;
  const platforms = text.split(',').map((entry) => parseSourceKey(entry.trim()));
  if (platforms.length === 0 || new Set(platforms).size !== platforms.length) {
    throw new TypeError('SEARCH_PLATFORMS must contain unique source IDs.');
  }
  return Object.freeze(platforms);
}

function timezone(value: string | undefined): string {
  const result = optional(value) ?? 'Europe/Moscow';
  try { new Intl.DateTimeFormat('en', { timeZone: result }).format(); }
  catch { throw new TypeError('TIMEZONE must be an IANA time-zone identifier.'); }
  return result;
}

function score(value: string | undefined, fallback: number, name: string): number {
  return parseInteger(value, fallback, name, 0, 100);
}
function positive(value: string | undefined, fallback: number, name: string): number {
  return parseInteger(value, fallback, name, 1);
}
function seconds(value: string | undefined, fallback: number, name: string): number {
  const parsed = positive(value, fallback, name);
  if (parsed > Math.floor(Number.MAX_SAFE_INTEGER / 1_000)) throw new RangeError(`${name} is too large.`);
  return parsed * 1_000;
}

export function parseConfig(env: Readonly<Record<string, string | undefined>>): AppConfig {
  const telegramMode = parseTelegramMode(env.TELEGRAM_MODE, env.TELEGRAM_POLLING);
  const telegramWebhookUrl = optional(env.TELEGRAM_WEBHOOK_URL);
  const telegramWebhookSecret = optional(env.TELEGRAM_WEBHOOK_SECRET);
  if (telegramMode === 'webhook') {
    if (!telegramWebhookUrl || !/^https:\/\//u.test(telegramWebhookUrl)) throw new TypeError('Webhook mode requires an HTTPS TELEGRAM_WEBHOOK_URL.');
    if (!telegramWebhookSecret || !/^[A-Za-z0-9_-]{32,256}$/u.test(telegramWebhookSecret)) {
      throw new TypeError('Webhook mode requires a 32–256 character URL-safe TELEGRAM_WEBHOOK_SECRET.');
    }
  }

  const digestMinScore = score(env.DIGEST_MIN_SCORE, 50, 'DIGEST_MIN_SCORE');
  const alertScore = score(env.ALERT_SCORE, 80, 'ALERT_SCORE');
  if (digestMinScore >= alertScore) throw new RangeError('DIGEST_MIN_SCORE must be below ALERT_SCORE.');
  const scoreConcurrencyMin = positive(env.SCORE_AGENT_CONCURRENCY_MIN, 5, 'SCORE_AGENT_CONCURRENCY_MIN');
  const scoreConcurrencyMax = positive(env.SCORE_AGENT_CONCURRENCY_MAX, 10, 'SCORE_AGENT_CONCURRENCY_MAX');
  if (scoreConcurrencyMin > scoreConcurrencyMax) throw new RangeError('Minimum score concurrency must not exceed maximum.');
  const unitCadenceFloorMinutes = positive(env.UNIT_CADENCE_FLOOR_MINUTES, 30, 'UNIT_CADENCE_FLOOR_MINUTES');
  const unitCadenceCeilingMinutes = positive(env.UNIT_CADENCE_CEILING_MINUTES, 720, 'UNIT_CADENCE_CEILING_MINUTES');
  if (unitCadenceFloorMinutes > unitCadenceCeilingMinutes) throw new RangeError('Cadence floor must not exceed cadence ceiling.');
  const userDailyApplicationLimit = positive(env.USER_DAILY_APPLICATION_LIMIT, 5, 'USER_DAILY_APPLICATION_LIMIT');
  const userDailyCoverLetterLimit = positive(env.USER_DAILY_COVER_LETTER_LIMIT, 20, 'USER_DAILY_COVER_LETTER_LIMIT');
  if (userDailyCoverLetterLimit < userDailyApplicationLimit) {
    throw new RangeError('Cover-letter limit must not be below tailored-CV limit.');
  }
  const budgetCents = parseInteger(env.USER_DAILY_LLM_BUDGET_CENTS, 200, 'USER_DAILY_LLM_BUDGET_CENTS', 0);
  const clusterPercent = parseInteger(env.SEARCH_CLUSTER_SIMILARITY, 60, 'SEARCH_CLUSTER_SIMILARITY', 0, 100);
  const postgresSsl = optional(env.POSTGRES_SSL)?.toLowerCase() ?? 'require';
  if (postgresSsl !== 'disable' && postgresSsl !== 'require' && postgresSsl !== 'verify-full') {
    throw new TypeError('POSTGRES_SSL must be disable, require, or verify-full.');
  }
  const owner = optional(env.TELEGRAM_USER_ID);
  if (owner !== undefined && !/^[1-9]\d*$/u.test(owner)) throw new TypeError('TELEGRAM_USER_ID must be a positive decimal ID.');

  return Object.freeze({
    generationModel: parseModelId(env.AI_MODEL, 'AI_MODEL'),
    generationThinking: parseThinkingLevel(env.AI_THINKING_LEVEL, 'AI_THINKING_LEVEL'),
    scoringModel: parseModelId(env.AI_SCORING_MODEL, 'AI_SCORING_MODEL'),
    scoringThinking: parseThinkingLevel(env.AI_SCORING_THINKING_LEVEL, 'AI_SCORING_THINKING_LEVEL'),
    prescoringModel: parseModelId(env.AI_PRESCORING_MODEL, 'AI_PRESCORING_MODEL'),
    prescoringThinking: parseThinkingLevel(env.AI_PRESCORING_THINKING_LEVEL, 'AI_PRESCORING_THINKING_LEVEL'),
    scoringFallbackModel: parseModelId(env.AI_SCORING_FALLBACK_MODEL, 'AI_SCORING_FALLBACK_MODEL'),
    scoringFallbackThinking: parseThinkingLevel(env.AI_SCORING_FALLBACK_THINKING_LEVEL, 'AI_SCORING_FALLBACK_THINKING_LEVEL'),
    additionalMaxPages: positive(env.ADDITIONAL_MAX_PAGES, 1, 'ADDITIONAL_MAX_PAGES'),
    searchPageBudgetPerPlatform: positive(env.SEARCH_PAGE_BUDGET_PER_PLATFORM, 12, 'SEARCH_PAGE_BUDGET_PER_PLATFORM'),
    searchQueriesPerCycle: positive(env.SEARCH_QUERIES_PER_CYCLE, 1, 'SEARCH_QUERIES_PER_CYCLE'),
    searchNewVacancyLimit: positive(env.SEARCH_NEW_VACANCY_LIMIT, 10, 'SEARCH_NEW_VACANCY_LIMIT'),
    searchClusterSimilarity: clusterPercent / 100,
    vacancyRetentionDays: positive(env.VACANCY_RETENTION_DAYS, 30, 'VACANCY_RETENTION_DAYS'),
    vacancyPurgeBatchSize: positive(env.VACANCY_PURGE_BATCH_SIZE, 500, 'VACANCY_PURGE_BATCH_SIZE'),
    normalizationBatchSizePerUser: positive(env.NORMALIZATION_BATCH_SIZE_PER_USER, 10, 'NORMALIZATION_BATCH_SIZE_PER_USER'),
    normalizeSourceConcurrency: positive(env.NORMALIZE_SOURCE_CONCURRENCY, 3, 'NORMALIZE_SOURCE_CONCURRENCY'),
    discoveryTickConcurrency: positive(env.DISCOVERY_TICK_CONCURRENCY, 3, 'DISCOVERY_TICK_CONCURRENCY'),
    candidateRefreshBatchSize: positive(env.CANDIDATE_REFRESH_BATCH_SIZE, 2, 'CANDIDATE_REFRESH_BATCH_SIZE'),
    candidateRefreshDays: positive(env.CANDIDATE_REFRESH_DAYS, 7, 'CANDIDATE_REFRESH_DAYS'),
    prefilterMinScore: score(env.PREFILTER_MIN_SCORE, 20, 'PREFILTER_MIN_SCORE'),
    prefilterMaxAgeDays: positive(env.PREFILTER_MAX_AGE_DAYS, 30, 'PREFILTER_MAX_AGE_DAYS'),
    prescoreMinScore: score(env.PRESCORE_MIN_SCORE, 40, 'PRESCORE_MIN_SCORE'),
    prescoreBatchSize: positive(env.PRESCORE_BATCH_SIZE, 10, 'PRESCORE_BATCH_SIZE'),
    prescoreLimitPerCycle: positive(env.PRESCORE_LIMIT_PER_CYCLE, 60, 'PRESCORE_LIMIT_PER_CYCLE'),
    prescoreExplorationRate: parseFraction(env.PRESCORE_EXPLORATION_RATE, 0.1, 'PRESCORE_EXPLORATION_RATE'),
    prescorePromptVersion: optional(env.PRESCORE_PROMPT_VERSION) ?? 'v2',
    scoreConcurrencyMin, scoreConcurrencyMax,
    scoreBatchSize: positive(env.SCORE_BATCH_SIZE, 3, 'SCORE_BATCH_SIZE'),
    scoringBatchTimeoutMs: seconds(env.SCORING_BATCH_TIMEOUT_SECONDS, 180, 'SCORING_BATCH_TIMEOUT_SECONDS'),
    scoringBatchMaxAttempts: positive(env.SCORING_BATCH_MAX_ATTEMPTS, 3, 'SCORING_BATCH_MAX_ATTEMPTS'),
    userScoreLimitPerCycle: positive(env.USER_SCORE_LIMIT_PER_CYCLE, 3, 'USER_SCORE_LIMIT_PER_CYCLE'),
    userDailyLlmBudgetUsd: budgetCents / 100,
    unitCadenceFloorMinutes, unitCadenceCeilingMinutes,
    userDailyApplicationLimit, userDailyCoverLetterLimit,
    userDailySearchProfileLimit: positive(env.USER_DAILY_SEARCH_PROFILE_LIMIT, 24, 'USER_DAILY_SEARCH_PROFILE_LIMIT'),
    userWorkflowConcurrency: positive(env.USER_WORKFLOW_CONCURRENCY, 5, 'USER_WORKFLOW_CONCURRENCY'),
    deliveryConcurrency: positive(env.DELIVERY_CONCURRENCY, 5, 'DELIVERY_CONCURRENCY'),
    maxPendingWorkerJobs: positive(env.MAX_PENDING_WORKER_JOBS, 100, 'MAX_PENDING_WORKER_JOBS'),
    accessRequestCooldownMinutes: positive(env.ACCESS_REQUEST_COOLDOWN_MINUTES, 60, 'ACCESS_REQUEST_COOLDOWN_MINUTES'),
    cvUploadSessionCooldownMinutes: positive(env.CV_UPLOAD_SESSION_COOLDOWN_MINUTES, 15, 'CV_UPLOAD_SESSION_COOLDOWN_MINUTES'),
    digestMinScore, alertScore, timezone: timezone(env.TIMEZONE), defaultLocale: parseLocale(env.BOT_LOCALE, 'ru'),
    ownerTelegramUserId: owner, searchPlatforms: parsePlatformList(env.SEARCH_PLATFORMS),
    engineMode: parseBoolean(env.RUN_JOBS, true, 'RUN_JOBS') ? 'run' : 'off', telegramMode,
    telegramBotToken: optional(env.TELEGRAM_BOT_TOKEN), telegramWebhookUrl, telegramWebhookSecret,
    databaseUrl: optional(env.DATABASE_URL), postgresPoolMax: positive(env.POSTGRES_POOL_MAX, 4, 'POSTGRES_POOL_MAX'),
    postgresSsl, postgresCaCert: optional(env.POSTGRES_CA_CERT), appPort: parseInteger(env.APP_PORT, 3000, 'APP_PORT', 1, 65535),
    extensionsPath: optional(env.JOBSEEKER_EXTENSIONS) ?? './extensions', aiAuthFile: optional(env.AI_AUTH_FILE) ?? './auth/auth.json',
    stateStorageUrl: optional(env.STATE_STORAGE_URL), stateStorageKey: optional(env.STATE_STORAGE_KEY),
    stateStorageBucket: optional(env.STATE_STORAGE_BUCKET), runtimeStateEncryptionKey: optional(env.RUNTIME_STATE_ENCRYPTION_KEY),
  });
}

export const config = parseConfig(process.env);
