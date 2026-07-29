import { Cron } from 'croner';
import { config } from '../config.ts';
import {
  approvedUsers, clearPendingDelivery, getDeliveryWindow, getGlobalScheduleCron, pendingDeliveries,
  queueDelivery, saveDeliveryWindow, saveGlobalScheduleCron, type DeliveryKind, type DeliveryWindow,
  type GlobalScheduleName,
} from './database.ts';
import { errorMessage } from './logging.ts';

type GlobalHandler = () => Promise<unknown>;
type UserHandler = (userId: string) => Promise<unknown>;

const jobs = new Map<GlobalScheduleName, Cron>();
const runningDeliveries = new Set<string>();
let scrapeHandler: GlobalHandler | undefined;
let notifyHandler: UserHandler | undefined;
let digestHandler: UserHandler | undefined;
let deliveryPoller: Cron | undefined;

const defaults: Record<GlobalScheduleName, string> = {
  scrape: config.scrapeCron,
  notify: config.notifyCron,
  digest: config.digestCron,
};

function validateCron(pattern: string): void {
  const fields = pattern.trim().split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) throw new Error('Cron must contain 5 fields, or 6 fields with seconds.');
  const probe = new Cron(pattern, { timezone: config.timezone, paused: true });
  if (!probe.nextRun()) throw new Error('Cron expression has no future run time.');
  probe.stop();
}

function localMinutes(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  return hour * 60 + minute;
}

export function isWithinDeliveryWindow(userId: string, date = new Date()): boolean {
  const window = getDeliveryWindow(userId);
  if (!window) return true;
  const minutes = localMinutes(date, window.timezone);
  return window.startMinutes < window.endMinutes
    ? minutes >= window.startMinutes && minutes < window.endMinutes
    : minutes >= window.startMinutes || minutes < window.endMinutes;
}

async function deliver(userId: string, kind: DeliveryKind, queueWhenClosed: boolean): Promise<void> {
  if (!isWithinDeliveryWindow(userId)) {
    if (queueWhenClosed) queueDelivery(userId, kind);
    return;
  }
  const handler = kind === 'notify' ? notifyHandler : digestHandler;
  if (!handler) throw new Error('Delivery schedules have not been initialized.');
  const key = `${userId}:${kind}`;
  if (runningDeliveries.has(key)) return;
  runningDeliveries.add(key);
  try {
    await handler(userId);
    clearPendingDelivery(userId, kind);
  } catch (error) {
    queueDelivery(userId, kind);
    console.error(`${kind} delivery failed for user ${userId}: ${errorMessage(error)}`);
  } finally {
    runningDeliveries.delete(key);
  }
}

async function dispatch(kind: DeliveryKind): Promise<void> {
  for (const user of approvedUsers()) await deliver(user.userId, kind, true);
}

export async function flushPendingDeliveries(): Promise<void> {
  for (const pending of pendingDeliveries()) await deliver(pending.userId, pending.kind, false);
}

function createJob(name: GlobalScheduleName, pattern: string): Cron {
  return new Cron(pattern, {
    timezone: config.timezone,
    protect: true,
    catch: (error) => console.error(`${name} schedule failed: ${errorMessage(error)}`),
  }, async () => {
    if (name === 'scrape') {
      if (!scrapeHandler) throw new Error('Scrape schedule has not been initialized.');
      await scrapeHandler();
    } else await dispatch(name);
  });
}

export function initializeSchedules(scrape: GlobalHandler, notify: UserHandler, digest: UserHandler): void {
  scrapeHandler = scrape; notifyHandler = notify; digestHandler = digest;
  if (!config.runJobs) return;
  for (const name of ['scrape', 'notify', 'digest'] as const) {
    const pattern = getGlobalScheduleCron(name) ?? defaults[name];
    validateCron(pattern);
    jobs.set(name, createJob(name, pattern));
  }
  deliveryPoller = new Cron('* * * * *', { timezone: 'UTC', protect: true,
    catch: (error) => console.error(`Pending delivery poll failed: ${errorMessage(error)}`) }, flushPendingDeliveries);
}

export function scheduleStatus(name: GlobalScheduleName): { cron: string; nextRun: Date | null } {
  const cron = getGlobalScheduleCron(name) ?? defaults[name];
  const job = jobs.get(name);
  if (job) return { cron, nextRun: job.nextRun() };
  validateCron(cron);
  const probe = new Cron(cron, { timezone: config.timezone, paused: true });
  const nextRun = probe.nextRun(); probe.stop();
  return { cron, nextRun };
}

export function updateSchedule(name: GlobalScheduleName, pattern: string): { cron: string; nextRun: Date | null } {
  const cron = pattern.trim(); validateCron(cron);
  const replacement = config.runJobs ? createJob(name, cron) : undefined;
  try { saveGlobalScheduleCron(name, cron); } catch (error) { replacement?.stop(); throw error; }
  jobs.get(name)?.stop();
  if (replacement) jobs.set(name, replacement); else jobs.delete(name);
  return { cron, nextRun: replacement?.nextRun() ?? null };
}

function parseMinutes(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error('Times must use HH:MM format.');
  const hour = Number(match[1]); const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error('Time is outside the valid 00:00–23:59 range.');
  return hour * 60 + minute;
}
function timeText(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
export function deliveryWindowStatus(userId: string): string {
  const window = getDeliveryWindow(userId);
  return window ? `${timeText(window.startMinutes)}-${timeText(window.endMinutes)} ${window.timezone}` : 'anytime';
}
export function updateDeliveryWindow(userId: string, input: string): DeliveryWindow | null {
  const value = input.trim();
  if (value.toLowerCase() === 'off') { saveDeliveryWindow(userId, null); void flushPendingDeliveries(); return null; }
  const match = /^(\d{2}:\d{2})-(\d{2}:\d{2})\s+(\S+)$/.exec(value);
  if (!match) throw new Error('Use /window HH:MM-HH:MM Area/City, or /window off.');
  const startMinutes = parseMinutes(match[1]); const endMinutes = parseMinutes(match[2]);
  if (startMinutes === endMinutes) throw new Error('Start and end times must differ; use /window off for anytime.');
  try { new Intl.DateTimeFormat('en', { timeZone: match[3] }).format(); }
  catch { throw new Error(`Unknown IANA timezone: ${match[3]}`); }
  const window = { startMinutes, endMinutes, timezone: match[3] };
  saveDeliveryWindow(userId, window); void flushPendingDeliveries();
  return window;
}

export function stopSchedules(): void {
  for (const job of jobs.values()) job.stop();
  deliveryPoller?.stop();
}
