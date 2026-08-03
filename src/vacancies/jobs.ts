import { createHash } from 'node:crypto';
import { config } from '../config.ts';
import {
  approvedUsers, candidatesDueForRefresh, candidatesNeedingPrefilter, getCvSource, getDeliverySettings, getSearchProfile,
  markCandidateClosed, markCandidateFailed, markCandidateNormalized, markDigestRun, rankedCandidateQueueForUsers,
  saveCandidatePrefilter, saveDeliverySettings, upsertVacancy,
  type Vacancy, type VacancyCandidate, type VacancyInput,
} from '../database.ts';
import { prefilterVacancy } from '../prefilter.ts';
import { normalizePlatformCandidates } from './registry.ts';
import { trace } from '../observability.ts';
import { errorMessage } from '../observability.ts';
import { careerProfilePlatformId, parseStoredCareerProfile, type StoredCareerProfile } from '../prefilter.ts';

function candidateVacancy(candidate: VacancyCandidate): Vacancy {
  return {
    id: 0, source: candidate.source, sourceId: candidate.sourceId, applyId: 'aaaaaa',
    name: candidate.title || candidate.searchName, employer: '', area: '', salaryFrom: null, salaryTo: null,
    salaryCurrency: null, salaryGross: null, experience: '', employment: '', schedule: '', workFormat: '',
    // Listing summaries vary wildly by source, so regex/lexical ranking is deliberately title/query based.
    description: candidate.searchName, keySkills: [], url: candidate.url,
    publishedAt: candidate.publishedAt, sourceQuery: candidate.searchName, contentHash: candidate.listingHash, decision: 'new',
  };
}

type QueueProgress = (phase: 'filtering' | 'normalization', current: number, total: number) => void;

async function prefilterCandidates(userIds: string[], progress?: QueueProgress): Promise<{ evaluated: number; queued: number }> {
  const profiles = (await Promise.all(userIds.map(async (userId) => {
    const cv = await getCvSource(userId);
    if (!cv) return null;
    const careerProfile = parseStoredCareerProfile(
      await getSearchProfile<StoredCareerProfile>(userId, careerProfilePlatformId), cv.cvSha256,
    );
    if (!careerProfile) return null;
    const profileHash = createHash('sha256').update(JSON.stringify(careerProfile)).digest('hex');
    const contextHash = createHash('sha256').update(['candidate-prefilter-v6-lexical-per-user', cv.cvSha256, profileHash,
      config.prefilterMinScore].join(':')).digest('hex');
    const candidates = await candidatesNeedingPrefilter(userId, contextHash, config.candidatePrefilterBatchSize);
    return { userId, cvText: cv.cvText, cvHash: cv.cvSha256, careerProfile, contextHash, candidates };
  }))).filter((profile) => profile !== null);
  const total = profiles.reduce((sum, profile) => sum + profile.candidates.length, 0);
  if (!total) return { evaluated: 0, queued: 0 };
  let completed = 0; let queued = 0;
  progress?.('filtering', 0, total);
  for (const profile of profiles) {
    for (const candidate of profile.candidates) {
      const vacancy = candidateVacancy(candidate);
      const result = prefilterVacancy(profile.cvText, vacancy, config.prefilterMinScore, profile.careerProfile);
      await saveCandidatePrefilter(profile.userId, candidate, profile.contextHash, { ...result, auditSelected: false });
      if (!result.filtered) queued++;
      trace('candidate.prefilter.scored', { userId: profile.userId, source: candidate.source,
        sourceId: candidate.sourceId, title: candidate.title, ...result });
      progress?.('filtering', ++completed, total);
    }
  }
  return { evaluated: total, queued };
}

export interface CandidateQueueResult { evaluated: number; queued: number; selected: number; refreshed: number; normalized: number; failed: number; closed: number; bySource: Record<string, number> }

export async function processCandidateQueue(userIds: string[], progress?: QueueProgress): Promise<CandidateQueueResult> {
  const prefilter = await prefilterCandidates(userIds, progress);
  const capacity = config.normalizationBatchSizePerUser * userIds.length;
  const ranked = await rankedCandidateQueueForUsers(userIds, config.normalizationBatchSizePerUser);
  const refresh = await candidatesDueForRefresh(
    Math.min(config.candidateRefreshBatchSize, Math.max(0, capacity - ranked.length)), config.candidateRefreshDays);
  const selected = [...ranked, ...refresh];
  trace('candidate.queue.ranked', { perUserBatchSize: config.normalizationBatchSizePerUser, capacity,
    selected: selected.map((candidate) => ({ source: candidate.source, sourceId: candidate.sourceId,
      title: candidate.title, score: candidate.combinedScore })) });
  const normalizationResults = new Map<string, VacancyInput | null | Error>();
  for (const source of new Set(selected.map((candidate) => candidate.source))) {
    const candidates = selected.filter((candidate) => candidate.source === source);
    const results = await normalizePlatformCandidates(source,candidates);
    for (const [sourceId,result] of results) normalizationResults.set(`${source}:${sourceId}`,result);
  }
  let normalized = 0; let failed = 0; let closed = 0;
  const bySource: Record<string, number> = {};
  progress?.('normalization', 0, selected.length);
  for (const [index, candidate] of selected.entries()) {
    try {
      const result = normalizationResults.get(`${candidate.source}:${candidate.sourceId}`);
      if (result instanceof Error) throw result;
      if (!result) { await markCandidateClosed(candidate); closed++; continue; }
      const saved = await upsertVacancy(result);
      await markCandidateNormalized(candidate, saved.id, Boolean(saved.duplicate));
      if (saved.needsScore) { normalized++; bySource[candidate.source] = (bySource[candidate.source] ?? 0) + 1; }
      trace('candidate.normalized', { source: candidate.source, sourceId: candidate.sourceId, saved, vacancy: result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/\b(?:404|410)\b|not found|archived|закрыт|в архиве/i.test(message)) { await markCandidateClosed(candidate); closed++; }
      else { failed++; await markCandidateFailed(candidate, message); }
      console.error(`Failed to normalize queued candidate ${candidate.source}:${candidate.sourceId}: ${errorMessage(error)}`);
    }
    progress?.('normalization', index + 1, selected.length);
  }
  return { ...prefilter, selected: selected.length, refreshed: refresh.length, normalized, failed, closed, bySource };
}

import { startCycleStatus } from '../telegram.ts';
import { ensureCvAndSearchProfiles, scorePendingVacancies } from '../workflows.ts';
import { discoverPlatformVacancies } from './registry.ts';
import { mapConcurrent } from '../concurrency.ts';
import { llmUsageSince, llmUsageSnapshot, type LlmUsageReport } from '../ai.ts';

let cycleRunning = false;
export type UserTaskRunner = <T>(userId: string, task: () => Promise<T>) => Promise<T>;
const runDirectly: UserTaskRunner = (_userId, task) => task();

export interface PlatformScrapeResult { searches: number; seen: number; discovered: number; newVacancies: number }
export interface ScrapeCycleResult {
  platforms: Record<string, PlatformScrapeResult>;
  users: number;
  searches: number;
  seen: number;
  discovered: number;
  newVacancies: number;
  candidateQueue: Awaited<ReturnType<typeof processCandidateQueue>>;
  scoresAttempted: number;
  llmUsage: LlmUsageReport;
}

async function retryTransientPostgres<T>(label:string,operation:()=>Promise<T>):Promise<T>{
  for(let attempt=0;;attempt++){
    try{return await operation();}catch(error){
      if(attempt>=2||!transientPostgresError(error))throw error;
      console.warn(`${label} hit a transient PostgreSQL failure; retrying (${attempt+1}/2).`);
      await new Promise(resolve=>setTimeout(resolve,1_000*2**attempt));
    }
  }
}

function addPlatformResult(target: Record<string, PlatformScrapeResult>, platformId: string,
  result: Omit<PlatformScrapeResult, 'newVacancies'>): void {
  const current = target[platformId] ?? { searches: 0, seen: 0, discovered: 0, newVacancies: 0 };
  target[platformId] = { ...current, searches: current.searches + result.searches,
    seen: current.seen + result.seen, discovered: current.discovered + result.discovered };
}

export async function runScrapeCycle(runUserTask: UserTaskRunner = runDirectly): Promise<ScrapeCycleResult | null> {
  if (cycleRunning) return null;
  cycleRunning = true;
  const usageBefore = llmUsageSnapshot();
  const cycleStatus = await startCycleStatus();
  cycleStatus?.set('scraping');
  try {
    const users = await approvedUsers(true);
    trace('cycle.start', { users: users.map((user) => user.userId), platforms: config.searchPlatforms,
      scoreLimitPerUser: config.userScoreLimitPerCycle });
    const platforms: Record<string, PlatformScrapeResult> = {};
    const scrapeTotal=users.length*config.searchPlatforms.length;let scrapeCompleted=0;
    cycleStatus?.set('scraping',0,scrapeTotal);
    await mapConcurrent(users, config.userWorkflowConcurrency, async (user) => {
      try {
        await runUserTask(user.userId, async () => {
          const profiles = await ensureCvAndSearchProfiles(user.userId);
          for (const platformId of config.searchPlatforms) {
            try {
              trace('scrape.platform.start', { userId: user.userId, platform: platformId, profile: profiles[platformId] });
              const profile = profiles[platformId];
              if (!profile) throw new Error(`${platformId} search profile is unavailable`);
              addPlatformResult(platforms, platformId, await discoverPlatformVacancies(platformId,user.userId,profile));
            } catch (error) {
              console.error(`Failed to scrape ${platformId} for user ${user.userId}: ${errorMessage(error)}`);
            } finally {
              scrapeCompleted++;cycleStatus?.set('scraping',scrapeCompleted,scrapeTotal);
              console.info(`Scrape progress ${scrapeCompleted}/${scrapeTotal} (${platformId})`);
            }
          }
        });
      } catch (error) {
        console.error(`Scrape allocation failed for user ${user.userId}: ${errorMessage(error)}`);
      }
    });
    const queue = await processCandidateQueue(users.map((user) => user.userId),
      (phase, current, total) => cycleStatus?.set(phase, current, total));
    for (const [source, count] of Object.entries(queue.bySource)) {
      if (platforms[source]) platforms[source].newVacancies = count;
    }
    const scoreCounts = await mapConcurrent(users, config.userWorkflowConcurrency, async (user) => {
      try {
        return await retryTransientPostgres('Scoring allocation',()=>runUserTask(user.userId,
          () => scorePendingVacancies(user.userId, undefined,
            (phase, current, total) => cycleStatus?.set(phase, current, total), config.userScoreLimitPerCycle)));
      } catch (error) {
        console.error(`Scoring allocation failed for user ${user.userId}: ${errorMessage(error)}`);
        return 0;
      }
    });
    const attempted = scoreCounts.reduce((sum, count) => sum + count, 0);
    const totals = Object.values(platforms).reduce((sum, platform) => ({
      searches: sum.searches + platform.searches, seen: sum.seen + platform.seen,
      discovered: sum.discovered + platform.discovered, newVacancies: sum.newVacancies + platform.newVacancies,
    }), { searches: 0, seen: 0, discovered: 0, newVacancies: 0 });
    const result = { platforms, users: users.length, ...totals, candidateQueue: queue, scoresAttempted: attempted,
      llmUsage: llmUsageSince(usageBefore) };
    trace('cycle.completed', result);
    console.info(`LLM cycle usage ${JSON.stringify(result.llmUsage)}`);
    console.info('Vacancy cycle complete', result);
    return result;
  } finally {
    await cycleStatus?.stop();
    cycleRunning = false;
  }
}

import { Cron } from 'croner';
import type { DeliverySettings } from '../database.ts';

type GlobalHandler = () => Promise<unknown>;
type UserHandler = (userId: string) => Promise<unknown>;

const defaultDigestMinutes = 9 * 60;
let cycleJob: Cron | undefined;
let scheduledCycleRunning = false;
let scrapeHandler: GlobalHandler | undefined;
let notifyHandler: UserHandler | undefined;
let digestHandler: UserHandler | undefined;

function validateCron(pattern: string): void {
  const fields = pattern.trim().split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) throw new Error('CYCLE_CRON must contain 5 fields, or 6 fields with seconds.');
  const probe = new Cron(pattern, { timezone: config.timezone, paused: true });
  if (!probe.nextRun()) throw new Error('CYCLE_CRON has no future run time.');
  probe.stop();
}

export function parseClockMinutes(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) throw new Error('Введите время в формате ЧЧ:ММ, например 09:30.');
  const hour = Number(match[1]); const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error('Время должно быть в диапазоне от 00:00 до 23:59.');
  return hour * 60 + minute;
}

export function normalizeUtcOffset(value: string): string {
  const match = /^([+-])(\d{1,2})(?::(00|30))?$/.exec(value.trim());
  if (!match) throw new Error('Укажите смещение от UTC, например +3, -5 или +3:30.');
  const hour = Number(match[2]); const minute = Number(match[3] ?? '00');
  if (hour > 14 || (hour === 14 && minute !== 0)) throw new Error('Смещение UTC должно быть от -14:00 до +14:00.');
  if (hour === 0 && minute === 0) return '+00:00';
  return `${match[1]}${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function offsetMinutes(timezone: string): number | null {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(timezone);
  if (!match) return null;
  const total = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -total : total;
}

function localParts(date: Date, timezone: string): { minutes: number; dateKey: string } {
  const offset = offsetMinutes(timezone);
  if (offset != null) {
    const shifted = new Date(date.getTime() + offset * 60_000);
    return {
      minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
      dateKey: shifted.toISOString().slice(0, 10),
    };
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  return { minutes: Number(part('hour')) * 60 + Number(part('minute')),
    dateKey: `${part('year')}-${part('month')}-${part('day')}` };
}

async function effectiveSettings(userId: string): Promise<DeliverySettings> {
  return await getDeliverySettings(userId) ?? { startMinutes: 0, endMinutes: 0, digestMinutes: defaultDigestMinutes,
    timezone: config.timezone, lastDigestAt: null };
}

export async function isWithinDeliveryWindow(userId: string, date = new Date()): Promise<boolean> {
  const settings = await effectiveSettings(userId);
  if (settings.startMinutes === settings.endMinutes) return true;
  const minutes = localParts(date, settings.timezone).minutes;
  return settings.startMinutes < settings.endMinutes
    ? minutes >= settings.startMinutes && minutes < settings.endMinutes
    : minutes >= settings.startMinutes || minutes < settings.endMinutes;
}

export async function isDigestDue(userId: string, date = new Date()): Promise<boolean> {
  const settings = await effectiveSettings(userId);
  const local = localParts(date, settings.timezone);
  if (local.minutes < settings.digestMinutes) return false;
  if (!settings.lastDigestAt) return true;
  return localParts(new Date(settings.lastDigestAt), settings.timezone).dateKey < local.dateKey;
}

function timeText(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export async function deliverySettingsStatus(userId: string): Promise<string> {
  const configured = await getDeliverySettings(userId);
  const settings = await effectiveSettings(userId);
  const alerts = settings.startMinutes === settings.endMinutes ? 'в любое время'
    : `${timeText(settings.startMinutes)}–${timeText(settings.endMinutes)}`;
  const timezone = offsetMinutes(settings.timezone) == null ? settings.timezone : `UTC${settings.timezone}`;
  return `уведомления: ${alerts}; дайджест: ${timeText(settings.digestMinutes)}; ${timezone}${configured ? '' : ' (по умолчанию)'}`;
}

async function saveEffectiveSettings(userId: string, patch: Partial<Omit<DeliverySettings, 'lastDigestAt'>>): Promise<void> {
  const current = await effectiveSettings(userId);
  await saveDeliverySettings(userId, { startMinutes: patch.startMinutes ?? current.startMinutes,
    endMinutes: patch.endMinutes ?? current.endMinutes, digestMinutes: patch.digestMinutes ?? current.digestMinutes,
    timezone: patch.timezone ?? current.timezone });
}

export async function updateDeliveryWindow(userId: string, start: string, end: string): Promise<void> {
  const startMinutes = parseClockMinutes(start); const endMinutes = parseClockMinutes(end);
  if (startMinutes === endMinutes) throw new Error('Время начала и окончания уведомлений должно отличаться.');
  await saveEffectiveSettings(userId, { startMinutes, endMinutes });
}
export async function updateDeliveryTimezone(userId: string, timezone: string): Promise<void> {
  await saveEffectiveSettings(userId, { timezone: normalizeUtcOffset(timezone) });
}
export async function updateDigestTime(userId: string, digest: string): Promise<void> {
  await saveEffectiveSettings(userId, { digestMinutes: parseClockMinutes(digest) });
}
export async function removeDeliveryWindow(userId: string): Promise<void> {
  await saveEffectiveSettings(userId, { startMinutes: 0, endMinutes: 0 });
}
export async function digestSettingsStatus(userId: string, date = new Date()): Promise<string> {
  const configured = await getDeliverySettings(userId); const settings = await effectiveSettings(userId);
  const timezone = offsetMinutes(settings.timezone) == null ? settings.timezone : `UTC${settings.timezone}`;
  const lastParts = settings.lastDigestAt ? localParts(new Date(settings.lastDigestAt),settings.timezone) : null;
  const last = lastParts ? `${lastParts.dateKey} ${timeText(lastParts.minutes)}` : 'ещё не отправлялся';
  const due = await isDigestDue(userId,date);
  return `Состояние: включён${configured?'':' (по умолчанию)'}\nВремя: ${timeText(settings.digestMinutes)} · ${timezone}\n`+
    `Последняя отправка: ${last}\nСейчас: ${due?'готов к отправке':'ожидает времени или уже отправлен сегодня'}`;
}

async function sendAlerts(userId: string, now: Date): Promise<void> {
  if (!notifyHandler || !await isWithinDeliveryWindow(userId, now)) return;
  try { await notifyHandler(userId); }
  catch (error) { console.error(`Alert delivery failed for user ${userId}: ${errorMessage(error)}`); }
}

async function sendDigest(userId: string, now: Date): Promise<void> {
  if (!digestHandler || !await isDigestDue(userId, now)) return;
  try {
    await digestHandler(userId);
    await markDigestRun(userId, now.toISOString());
  } catch (error) { console.error(`Digest delivery failed for user ${userId}: ${errorMessage(error)}`); }
}

export async function runScheduledCycle(): Promise<void> {
  if (scheduledCycleRunning) return;
  if (!scrapeHandler || !notifyHandler || !digestHandler) throw new Error('Cycle schedule has not been initialized.');
  scheduledCycleRunning = true;
  try {
    try { await scrapeHandler(); }
    catch (error) { console.error(`Scrape cycle failed: ${errorMessage(error)}`); }
    const now = new Date();
    const users = await approvedUsers();
    await mapConcurrent(users, config.deliveryConcurrency, (user) => sendAlerts(user.userId, now));
    await mapConcurrent(users, config.deliveryConcurrency, (user) => sendDigest(user.userId, now));
  } finally { scheduledCycleRunning = false; }
}

export function initializeSchedules(scrape: GlobalHandler, notify: UserHandler, digest: UserHandler): void {
  scrapeHandler = scrape; notifyHandler = notify; digestHandler = digest;
  validateCron(config.cycleCron);
  if (!config.runJobs) return;
  cycleJob = new Cron(config.cycleCron, {
    timezone: config.timezone,
    protect: true,
    catch: (error) => console.error(`Cycle schedule failed: ${errorMessage(error)}`),
  }, runScheduledCycle);
}

export function stopSchedules(): void {
  cycleJob?.stop();
}

import { getPostgresPool, transientPostgresError } from '../postgres.ts';

export async function runSingletonScrapeCycle(runUserTask?: UserTaskRunner): Promise<ScrapeCycleResult | null> {
  const client = await getPostgresPool().connect();
  let acquired = false;
  try {
    const result = await client.query<{ acquired: boolean }>(
      "select pg_try_advisory_lock(hashtext('jobseeker-cycle')) acquired",
    );
    acquired = Boolean(result.rows[0]?.acquired);
    if (!acquired) {
      console.info('Skipping scrape cycle because another cycle holds the PostgreSQL advisory lock.');
      return null;
    }
    return await runScrapeCycle(runUserTask);
  } finally {
    if (acquired) await client.query("select pg_advisory_unlock(hashtext('jobseeker-cycle'))").catch(() => undefined);
    client.release();
  }
}
