import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseBoolean,
  parseConfig,
  parseFraction,
  parseInteger,
  parseModelId,
  parsePlatformList,
  parseTelegramMode,
  parseThinkingLevel,
} from '../src/config.ts';

test('primitive configuration parsers reject permissive deployment syntax', () => {
  assert.equal(parseInteger('12', 1, 'X', 1, 20), 12);
  for (const value of ['1.5', '1e2', '+1', '  ']) {
    if (value.trim()) assert.throws(() => parseInteger(value, 1, 'X'), /integer/u);
  }
  assert.equal(parseFraction('0.125', 0, 'X'), 0.125);
  for (const value of ['.5', '50%', '-0.1', '1.1', '1e-1']) assert.throws(() => parseFraction(value, 0, 'X'), /fraction/u);
  assert.equal(parseBoolean('TRUE', false, 'X'), true);
  assert.throws(() => parseBoolean('yes', false, 'X'), /true or false/u);
});

test('model, thinking, Telegram, and platform parsers retain explicit semantics', () => {
  assert.equal(parseModelId('', 'MODEL'), undefined);
  assert.equal(parseModelId('openrouter/anthropic/claude', 'MODEL'), 'openrouter/anthropic/claude');
  for (const value of ['claude', '/model', 'provider/', 'provider/bad model']) assert.throws(() => parseModelId(value, 'MODEL'), /provider\/model/u);
  assert.equal(parseThinkingLevel('XHIGH', 'THINKING'), 'xhigh');
  assert.throws(() => parseThinkingLevel('off', 'THINKING'), /unsupported/u);
  assert.equal(parseTelegramMode(undefined, 'false'), 'off');
  assert.equal(parseTelegramMode('webhook'), 'webhook');
  assert.equal(parsePlatformList('hh,ats')?.join(','), 'hh,ats');
  assert.equal(parsePlatformList(''), undefined);
  assert.throws(() => parsePlatformList('hh,hh'), /unique/u);
  assert.throws(() => parsePlatformList('HH'), /source key/u);
});

test('blank models remain undefined and defaults satisfy all cross-field invariants', () => {
  const parsed = parseConfig({ AI_MODEL: ' ', SEARCH_PLATFORMS: '', RUN_JOBS: 'false', TELEGRAM_POLLING: 'false' });
  assert.equal(parsed.generationModel, undefined);
  assert.equal(parsed.searchPlatforms, undefined);
  assert.equal(parsed.searchClusterSimilarity, 0.6);
  assert.equal(parsed.userDailyLlmBudgetUsd, 2);
  assert.equal(parsed.engineMode, 'off');
  assert.equal(parsed.telegramMode, 'off');
  assert.equal(parsed.prescoringThinking, undefined);
  assert.equal(Object.isFrozen(parsed), true);
});

test('configuration validates thresholds, limits, concurrency, cadence, locale, timezone, and webhook ownership', () => {
  const invalid: ReadonlyArray<readonly [Record<string, string>, RegExp]> = [
    [{ DIGEST_MIN_SCORE: '80', ALERT_SCORE: '80' }, /below/u],
    [{ USER_DAILY_APPLICATION_LIMIT: '10', USER_DAILY_COVER_LETTER_LIMIT: '9' }, /cover-letter/iu],
    [{ SCORE_AGENT_CONCURRENCY_MIN: '11', SCORE_AGENT_CONCURRENCY_MAX: '10' }, /minimum/iu],
    [{ UNIT_CADENCE_FLOOR_MINUTES: '60', UNIT_CADENCE_CEILING_MINUTES: '30' }, /cadence/iu],
    [{ BOT_LOCALE: 'de' }, /ru or en/u],
    [{ TIMEZONE: 'Moon/Sea' }, /time-zone/u],
    [{ TELEGRAM_MODE: 'webhook' }, /WEBHOOK_URL/u],
    [{ TELEGRAM_MODE: 'webhook', TELEGRAM_WEBHOOK_URL: 'http://example.test', TELEGRAM_WEBHOOK_SECRET: 'x'.repeat(32) }, /HTTPS/u],
    [{ TELEGRAM_MODE: 'webhook', TELEGRAM_WEBHOOK_URL: 'https://example.test', TELEGRAM_WEBHOOK_SECRET: 'short' }, /32/u],
  ];
  for (const [env, expected] of invalid) assert.throws(() => parseConfig(env), expected);
});

test('complete operator values are normalized once without credential exposure', () => {
  const parsed = parseConfig({
    AI_MODEL: 'anthropic/claude-sonnet', AI_THINKING_LEVEL: 'high', SEARCH_PLATFORMS: 'hh,ats',
    SEARCH_CLUSTER_SIMILARITY: '75', PRESCORE_EXPLORATION_RATE: '0.2', USER_DAILY_LLM_BUDGET_CENTS: '350',
    TELEGRAM_MODE: 'webhook', TELEGRAM_WEBHOOK_URL: 'https://bot.example/hook', TELEGRAM_WEBHOOK_SECRET: 's'.repeat(32),
    POSTGRES_SSL: 'verify-full', APP_PORT: '8080', TELEGRAM_USER_ID: '123',
  });
  assert.equal(parsed.generationModel, 'anthropic/claude-sonnet'); assert.equal(parsed.generationThinking, 'high');
  assert.deepEqual(parsed.searchPlatforms, ['hh', 'ats']); assert.equal(parsed.searchClusterSimilarity, .75);
  assert.equal(parsed.prescoringThinking, undefined); assert.equal(parsed.prescoreExplorationRate, .2);
  assert.equal(parsed.userDailyLlmBudgetUsd, 3.5); assert.equal(parsed.postgresSsl, 'verify-full'); assert.equal(parsed.appPort, 8080);
});
