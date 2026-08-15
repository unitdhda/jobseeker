import type { AlertVacancy, DigestPage, Locale, ScoredVacancy } from '@jobseeker/store';
import type { UserId } from '@jobseeker/engine/contracts';
import { messages } from '../i18n/index.ts';
import type { TelegramSendError } from './api.ts';
import { digestPageMeta } from './digest-page.ts';
import { formatDigestVacancy } from './format.ts';

export interface DeliveryTransport {
  sendAlert(userId: UserId, html: string, vacancy: AlertVacancy): Promise<void>;
  sendDigest(userId: UserId, html: string, page: number, pageCount: number): Promise<void>;
}
export interface DeliveryPorts {
  isApprovedUser(userId: UserId): Promise<boolean>;
  unsentHighScoreVacancies(userId: UserId, minimumScore: number, limit?: number): Promise<readonly AlertVacancy[]>;
  markAlerted(userId: UserId, vacancyId: number): Promise<boolean>;
  digestVacancies(userId: UserId, minimum: number, high: number, since: Date | null, until: Date): Promise<readonly ScoredVacancy[]>;
  addressableDigestPage(userId: UserId, minimum: number, high: number, pageSize: number, page: number): Promise<DigestPage>;
  replaceDigestSnapshot(userId: UserId, vacancyIds: readonly number[], deliveredAt: Date): Promise<void>;
  scoredVacancyApplyIds(userId: UserId): Promise<readonly string[]>;
}
function isRateLimit(error: unknown): error is TelegramSendError {
  return typeof error === 'object' && error !== null && (error as TelegramSendError).kind === 'rate-limit';
}
function digestHtml(vacancies: readonly ScoredVacancy[], scoredApplyIds: readonly string[], locale: Locale,
  page: number, pageCount: number): string {
  const title = `<b>${messages(locale).digestTitle(page + 1, pageCount)}</b>`;
  return [title, ...vacancies.map((vacancy) => formatDigestVacancy(vacancy, scoredApplyIds, locale))].join('\n\n');
}

export async function sendHighAlerts(input: {
  readonly userId: UserId; readonly locale: Locale; readonly minimumScore: number;
  readonly ports: DeliveryPorts; readonly transport: DeliveryTransport; readonly paceMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}): Promise<{ readonly sent: number; readonly deferred: boolean }> {
  if (!await input.ports.isApprovedUser(input.userId)) return Object.freeze({ sent: 0, deferred: false });
  const [vacancies, scoredApplyIds] = await Promise.all([
    input.ports.unsentHighScoreVacancies(input.userId, input.minimumScore), input.ports.scoredVacancyApplyIds(input.userId),
  ]);
  const sleep = input.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const pace = input.paceMs ?? 500; let sent = 0;
  for (const vacancy of vacancies) {
    try { await input.transport.sendAlert(input.userId, formatDigestVacancy(vacancy, scoredApplyIds, input.locale), vacancy); }
    catch (error) { if (isRateLimit(error)) return Object.freeze({ sent, deferred: true }); throw error; }
    if (await input.ports.markAlerted(input.userId, vacancy.id)) sent += 1;
    if (sent < vacancies.length && pace > 0) await sleep(pace);
  }
  return Object.freeze({ sent, deferred: false });
}

export async function onDemandDigest(input: {
  readonly userId: UserId; readonly locale: Locale; readonly page: number;
  readonly minimumScore: number; readonly alertScore: number; readonly ports: DeliveryPorts;
}): Promise<{ readonly html: string; readonly meta: ReturnType<typeof digestPageMeta>; readonly vacancies: readonly ScoredVacancy[] }> {
  const [page, scoredApplyIds] = await Promise.all([
    input.ports.addressableDigestPage(input.userId, input.minimumScore, input.alertScore, 10, input.page),
    input.ports.scoredVacancyApplyIds(input.userId),
  ]);
  const meta = digestPageMeta(page.total, input.page);
  const html = page.total === 0 ? messages(input.locale).noDigest
    : digestHtml(page.vacancies, scoredApplyIds, input.locale, meta.page, meta.pageCount);
  return Object.freeze({ html, meta, vacancies: page.vacancies });
}

export async function sendScheduledDigest(input: {
  readonly userId: UserId; readonly locale: Locale; readonly since: Date | null; readonly until: Date;
  readonly minimumScore: number; readonly alertScore: number; readonly ports: DeliveryPorts; readonly transport: DeliveryTransport;
}): Promise<number> {
  if (!await input.ports.isApprovedUser(input.userId)) return 0;
  const [vacancies, scoredApplyIds] = await Promise.all([
    input.ports.digestVacancies(input.userId, input.minimumScore, input.alertScore, input.since, input.until),
    input.ports.scoredVacancyApplyIds(input.userId),
  ]);
  if (vacancies.length === 0) return 0;
  const pageCount = Math.ceil(vacancies.length / 10);
  for (let page = 0; page < pageCount; page += 1) {
    const items = vacancies.slice(page * 10, (page + 1) * 10);
    await input.transport.sendDigest(input.userId, digestHtml(items, scoredApplyIds, input.locale, page, pageCount), page, pageCount);
  }
  await input.ports.replaceDigestSnapshot(input.userId, vacancies.map((vacancy) => vacancy.id), input.until);
  return vacancies.length;
}
