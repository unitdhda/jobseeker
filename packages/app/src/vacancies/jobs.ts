import { config } from '../config.ts';
import {
  approvedUsers, candidatesDueForRefresh, getDeliverySettings, markCandidateClosed, markCandidateFailed,
  markCandidateNormalized, purgeExpiredVacancies, queuedListings, saveDeliverySettings, upsertVacancy,
  type VacancyInput,
} from '../postgres.ts';
import { normalizePlatformCandidates } from './registry.ts';
import { trace } from '../observability.ts';
import { errorMessage } from '../observability.ts';
import { mapConcurrent } from '@jobseeker/engine/concurrency';
import type { DeliverySettings } from '../postgres.ts';
import { messages, type Locale } from '../i18n/index.ts';

export interface NormalizeListingsResult { expired: number; selected: number; refreshed: number; normalized: number;
  failed: number; closed: number; vacancyIds: number[]; bySource: Record<string, number> }

/**
 * Turns queued listings into full vacancies. Global, not per-user: who sees a listing is decided by matching after
 * normalization, so the queue no longer needs a user's prefilter to earn a slot — recency orders it.
 */
export async function normalizeListings(limit: number): Promise<NormalizeListingsResult> {
  // Retention runs before selection so a listing about to expire is never normalized first.
  const expired = await purgeExpiredVacancies(config.vacancyRetentionDays, config.vacancyPurgeBatchSize)
    .catch((error) => { console.error(`Vacancy retention pass failed: ${errorMessage(error)}`); return 0; });
  if (expired) trace('vacancy.expired', { expired, retentionDays: config.vacancyRetentionDays });
  const ranked = await queuedListings(limit);
  const refresh = await candidatesDueForRefresh(
    Math.min(config.candidateRefreshBatchSize, Math.max(0, limit - ranked.length)), config.candidateRefreshDays);
  const selected = [...ranked, ...refresh];
  trace('listing.queue.selected', { limit, selected: selected.map((candidate) => ({ source: candidate.source,
    sourceId: candidate.sourceId, title: candidate.title })) });
  const normalizationResults = new Map<string, VacancyInput | null | Error>();
  // Sources normalize concurrently because their costs differ by orders of magnitude — a browser-backed candidate
  // takes ~50s while API detail fetches take fractions of a second — and each source stream stays sequential
  // inside its provider, so per-host politeness is unchanged.
  await mapConcurrent([...new Set(selected.map((candidate) => candidate.source))],
    config.normalizeSourceConcurrency, async (source) => {
      const candidates = selected.filter((candidate) => candidate.source === source);
      const results = await normalizePlatformCandidates(source, candidates);
      for (const [sourceId, result] of results) normalizationResults.set(`${source}:${sourceId}`, result);
    });
  let normalized = 0; let failed = 0; let closed = 0;
  const vacancyIds: number[] = [];
  const bySource: Record<string, number> = {};
  for (const candidate of selected) {
    try {
      const result = normalizationResults.get(`${candidate.source}:${candidate.sourceId}`);
      if (result instanceof Error) throw result;
      if (!result) { await markCandidateClosed(candidate); closed++; continue; }
      const saved = await upsertVacancy(result);
      await markCandidateNormalized(candidate, saved.id, Boolean(saved.duplicate));
      if (saved.needsScore) { normalized++; vacancyIds.push(saved.id); bySource[candidate.source] = (bySource[candidate.source] ?? 0) + 1; }
      trace('candidate.normalized', { source: candidate.source, sourceId: candidate.sourceId, saved, vacancy: result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/\b(?:404|410)\b|not found|archived|закрыт|в архиве/i.test(message)) { await markCandidateClosed(candidate); closed++; }
      else { failed++; await markCandidateFailed(candidate, message); }
      console.error(`Failed to normalize queued candidate ${candidate.source}:${candidate.sourceId}: ${errorMessage(error)}`);
    }
  }
  return { expired, selected: selected.length, refreshed: refresh.length, normalized, failed, closed, vacancyIds, bySource };
}


type UserHandler = (userId: string) => Promise<unknown>;

const defaultDigestMinutes = 9 * 60;

/**
 * The delivery-window parsers reject input straight to the person who typed it, so they are told which locale to
 * complain in rather than defaulting to the deployment's language.
 */
export function parseClockMinutes(value: string, locale: Locale): number {
  const text = messages(locale).delivery;
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) throw new Error(text.invalidClock);
  const hour = Number(match[1]); const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(text.clockOutOfRange);
  return hour * 60 + minute;
}

export function normalizeUtcOffset(value: string, locale: Locale): string {
  const text = messages(locale).delivery;
  const match = /^([+-])(\d{1,2})(?::(00|30))?$/.exec(value.trim());
  if (!match) throw new Error(text.invalidOffset);
  const hour = Number(match[2]); const minute = Number(match[3] ?? '00');
  if (hour > 14 || (hour === 14 && minute !== 0)) throw new Error(text.offsetOutOfRange);
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

/**
 * Rendered for whoever is reading it, not for whoever it describes: the owner's user table shows every account's
 * delivery settings in the owner's language.
 */
export async function deliverySettingsStatus(userId: string, locale: Locale): Promise<string> {
  const text = messages(locale).delivery;
  const configured = await getDeliverySettings(userId);
  const settings = await effectiveSettings(userId);
  const alerts = settings.startMinutes === settings.endMinutes ? text.anyTime
    : `${timeText(settings.startMinutes)}–${timeText(settings.endMinutes)}`;
  const timezone = offsetMinutes(settings.timezone) == null ? settings.timezone : `UTC${settings.timezone}`;
  return text.status(alerts, timeText(settings.digestMinutes), timezone, !configured);
}

async function saveEffectiveSettings(userId: string, patch: Partial<Omit<DeliverySettings, 'lastDigestAt'>>): Promise<void> {
  const current = await effectiveSettings(userId);
  await saveDeliverySettings(userId, { startMinutes: patch.startMinutes ?? current.startMinutes,
    endMinutes: patch.endMinutes ?? current.endMinutes, digestMinutes: patch.digestMinutes ?? current.digestMinutes,
    timezone: patch.timezone ?? current.timezone });
}

export async function updateDeliveryWindow(userId: string, start: string, end: string, locale: Locale): Promise<void> {
  const startMinutes = parseClockMinutes(start, locale); const endMinutes = parseClockMinutes(end, locale);
  if (startMinutes === endMinutes) throw new Error(messages(locale).delivery.equalBounds);
  await saveEffectiveSettings(userId, { startMinutes, endMinutes });
}
export async function updateDeliveryTimezone(userId: string, timezone: string, locale: Locale): Promise<void> {
  await saveEffectiveSettings(userId, { timezone: normalizeUtcOffset(timezone, locale) });
}
export async function updateDigestTime(userId: string, digest: string, locale: Locale): Promise<void> {
  await saveEffectiveSettings(userId, { digestMinutes: parseClockMinutes(digest, locale) });
}
export async function removeDeliveryWindow(userId: string): Promise<void> {
  await saveEffectiveSettings(userId, { startMinutes: 0, endMinutes: 0 });
}

export async function deliverDueNotifications(notify:UserHandler,digest:UserHandler,now=new Date()):Promise<void>{
  const users=await approvedUsers();
  await mapConcurrent(users,config.deliveryConcurrency,async user=>{
    try{if(await isWithinDeliveryWindow(user.userId,now))await notify(user.userId);}
    catch(error){console.error(`Alert delivery failed for user ${user.userId}: ${errorMessage(error)}`);}
  });
  await mapConcurrent(users,config.deliveryConcurrency,async user=>{
    try{if(await isDigestDue(user.userId,now))await digest(user.userId);}
    catch(error){console.error(`Digest delivery failed for user ${user.userId}: ${errorMessage(error)}`);}
  });
}
