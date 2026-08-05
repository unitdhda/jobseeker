/**
 * The store composition root: turns the environment into store options exactly once. Entrypoints import this
 * module for its effect before anything touches a repository; everything else imports @jobseeker/store directly.
 * Env-shape validation lives here because it is the app's job; the package receives plain values.
 */
import type { PoolConfig } from 'pg';
import { configureStore } from '@jobseeker/store';
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

configureStore({
  databaseUrl: process.env.DATABASE_URL ?? '',
  poolMax: poolMaximum(),
  ssl: sslConfig(),
  settings: {
    telegramUserId: config.telegramUserId, telegramChatId: config.telegramChatId,
    accessRequestCooldownMinutes: config.accessRequestCooldownMinutes,
    prefilterMaxAgeDays: config.prefilterMaxAgeDays, searchPlatforms: config.searchPlatforms,
    digestMinScore: config.digestMinScore, alertScore: config.alertScore,
    normalizationPerSourceQuota: config.normalizationPerSourceQuota, timezone: config.timezone,
    safeVacancyUrl,
  },
});
