import { Cron } from 'croner';
import { config } from '../config.ts';
import {
  approvedUsers, getDeliverySettings, markDigestRun, saveDeliverySettings, type DeliverySettings,
} from './database.ts';
import { errorMessage } from './logging.ts';

type GlobalHandler = () => Promise<unknown>;
type UserHandler = (userId: string) => Promise<unknown>;

const defaultDigestMinutes = 9 * 60;
let cycleJob: Cron | undefined;
let cycleRunning = false;
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

function effectiveSettings(userId: string): DeliverySettings {
  return getDeliverySettings(userId) ?? { startMinutes: 0, endMinutes: 0, digestMinutes: defaultDigestMinutes,
    timezone: config.timezone, lastDigestAt: null };
}

export function isWithinDeliveryWindow(userId: string, date = new Date()): boolean {
  const settings = effectiveSettings(userId);
  if (settings.startMinutes === settings.endMinutes) return true;
  const minutes = localParts(date, settings.timezone).minutes;
  return settings.startMinutes < settings.endMinutes
    ? minutes >= settings.startMinutes && minutes < settings.endMinutes
    : minutes >= settings.startMinutes || minutes < settings.endMinutes;
}

export function isDigestDue(userId: string, date = new Date()): boolean {
  const settings = effectiveSettings(userId);
  const local = localParts(date, settings.timezone);
  if (local.minutes < settings.digestMinutes) return false;
  if (!settings.lastDigestAt) return true;
  return localParts(new Date(settings.lastDigestAt), settings.timezone).dateKey < local.dateKey;
}

function timeText(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function deliverySettingsStatus(userId: string): string {
  const configured = getDeliverySettings(userId);
  const settings = effectiveSettings(userId);
  const alerts = settings.startMinutes === settings.endMinutes ? 'в любое время'
    : `${timeText(settings.startMinutes)}–${timeText(settings.endMinutes)}`;
  const timezone = offsetMinutes(settings.timezone) == null ? settings.timezone : `UTC${settings.timezone}`;
  return `уведомления: ${alerts}; дайджест: ${timeText(settings.digestMinutes)}; ${timezone}${configured ? '' : ' (по умолчанию)'}`;
}

export function updateDeliverySettings(userId: string, start: string, end: string, digest: string, timezone: string): void {
  const startMinutes = parseClockMinutes(start); const endMinutes = parseClockMinutes(end);
  if (startMinutes === endMinutes) throw new Error('Время начала и окончания уведомлений должно отличаться.');
  saveDeliverySettings(userId, { startMinutes, endMinutes, digestMinutes: parseClockMinutes(digest),
    timezone: normalizeUtcOffset(timezone) });
}

async function sendAlerts(userId: string, now: Date): Promise<void> {
  if (!notifyHandler || !isWithinDeliveryWindow(userId, now)) return;
  try { await notifyHandler(userId); }
  catch (error) { console.error(`Alert delivery failed for user ${userId}: ${errorMessage(error)}`); }
}

async function sendDigest(userId: string, now: Date): Promise<void> {
  if (!digestHandler || !isDigestDue(userId, now)) return;
  try {
    await digestHandler(userId);
    markDigestRun(userId, now.toISOString());
  } catch (error) { console.error(`Digest delivery failed for user ${userId}: ${errorMessage(error)}`); }
}

export async function runScheduledCycle(): Promise<void> {
  if (cycleRunning) return;
  if (!scrapeHandler || !notifyHandler || !digestHandler) throw new Error('Cycle schedule has not been initialized.');
  cycleRunning = true;
  try {
    try { await scrapeHandler(); }
    catch (error) { console.error(`Scrape cycle failed: ${errorMessage(error)}`); }
    const now = new Date();
    for (const user of approvedUsers()) await sendAlerts(user.userId, now);
    for (const user of approvedUsers()) await sendDigest(user.userId, now);
  } finally { cycleRunning = false; }
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
