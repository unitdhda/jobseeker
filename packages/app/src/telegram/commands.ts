import { parseUserId, type UserId } from '@jobseeker/engine/contracts';
import type { DeliverySettings, Locale, Store, TelegramUser } from '@jobseeker/store';
import type { ApplicationArtifact } from '@jobseeker/store';
import type { JobWorkerClient } from '../worker-client.ts';
import { runtimeStatus, scraperStatus, usageStatus, type RuntimeStatusInput } from '../observability.ts';
import { armCvUpload, deliverApplicationArtifact, type ApplicationActionPorts, type ApplicationTransport, type CvActionPorts } from './actions.ts';
import type { ApprovedCommand, OwnerCommand, TelegramCommandHandlers, RoutedTelegramContext } from './bot.ts';
import { onDemandDigest, type DeliveryPorts } from './delivery.ts';
import { escapeHtml, formatNumber, splitTelegramHtml, telegramLink } from './format.ts';
import type { OwnerMessageHistory } from './owner-message-history.ts';

export interface CommandTransport {
  reply(userId: UserId, html: string): Promise<number | void>;
  sendDocument(userId: UserId, bytes: Uint8Array, filename: string): Promise<void>;
  confirmDelete(userId: UserId): Promise<void>;
}
export interface CommandPorts {
  readonly store: Pick<Store, 'getDeliverySettings' | 'saveDeliverySettings' | 'exportUserData' | 'getCvHash'
    | 'setUserStatus' | 'listTelegramUsers' | 'userUsageSummaries' | 'searchMatchedVacancies'
    | 'llmUsageSummary' | 'scraperSummary'>;
  readonly cvActions: CvActionPorts;
  readonly applicationActions: ApplicationActionPorts;
  readonly worker: Pick<JobWorkerClient, 'request'>;
  readonly applicationTransport: ApplicationTransport;
  readonly delivery: DeliveryPorts;
  readonly transport: CommandTransport;
  readonly configuredSources: readonly string[];
  readonly digestMinScore: number;
  readonly alertScore: number;
  readonly defaultTimezone: string;
  readonly runtimeStatus: () => RuntimeStatusInput;
  readonly ownerMessageHistory?: OwnerMessageHistory;
}

function requireUser(context: RoutedTelegramContext): TelegramUser {
  if (!context.user) throw new Error('Telegram command has no user.');
  return context.user;
}
const ownerGenerations = new WeakMap<RoutedTelegramContext, number>();
async function reply(input: CommandPorts, context: RoutedTelegramContext, html: string): Promise<void> {
  const userId = requireUser(context).userId;
  const messageId = await input.transport.reply(userId, html);
  const generation = ownerGenerations.get(context);
  if (typeof messageId === 'number' && generation !== undefined) input.ownerMessageHistory?.record(userId, generation, messageId);
}
function hour(value: string): number | null {
  if (!/^\d{1,2}$/u.test(value)) return null;
  const parsed = Number(value); return parsed >= 0 && parsed <= 23 ? parsed : null;
}
function userPrefix(userId: string, pageIds: readonly string[]): string {
  let length = 1;
  while (length < userId.length && pageIds.some((other) => other !== userId && other.startsWith(userId.slice(0, length)))) length++;
  return userId.slice(0, length);
}
function userStatus(status: TelegramUser['status'], locale: Locale): string {
  const labels = locale === 'ru'
    ? { unregistered: 'не зарегистрирован', pending: 'на рассмотрении', approved: 'одобрен', rejected: 'отклонён', revoked: 'отозван' }
    : { unregistered: 'not registered', pending: 'awaiting a decision', approved: 'approved', rejected: 'rejected', revoked: 'revoked' };
  return labels[status];
}
function deliveryStatus(settings: DeliverySettings | null, locale: Locale, fallbackTimezone: string): string {
  const timezone = settings?.timezone ?? fallbackTimezone;
  if (!settings) return locale === 'ru' ? `по умолчанию · ${escapeHtml(timezone)}` : `default · ${escapeHtml(timezone)}`;
  return `${settings.enabled ? (locale === 'ru' ? 'вкл.' : 'on') : (locale === 'ru' ? 'выкл.' : 'off')} · ${String(settings.digestHourUtc).padStart(2, '0')}:00 UTC · ${escapeHtml(timezone)}`;
}

export function createCommandHandlers(input: CommandPorts): TelegramCommandHandlers {
  const approved: Partial<Record<ApprovedCommand, (context: RoutedTelegramContext) => Promise<void> | void>> = {
      cv: async (context) => { const armed = await armCvUpload(input.cvActions, requireUser(context).userId);
        await reply(input, context, armed ? context.t.cvSendDocument : context.t.busy('cv-import')); },
      window: async (context) => {
        const user = requireUser(context); const requested = hour(context.argument);
        if (context.argument && requested === null) { await reply(input, context, 'Usage: /window 0..23'); return; }
        const current = await input.store.getDeliverySettings(user.userId);
        const settings: Omit<DeliverySettings, 'lastDigestAt'> = requested === null
          ? { enabled: !(current?.enabled ?? true), digestHourUtc: current?.digestHourUtc ?? 9, timezone: current?.timezone ?? input.defaultTimezone }
          : { enabled: true, digestHourUtc: requested, timezone: current?.timezone ?? input.defaultTimezone };
        await input.store.saveDeliverySettings(user.userId, settings);
        await reply(input, context, `Digest: ${settings.enabled ? 'on' : 'off'} · ${settings.digestHourUtc}:00 UTC`);
      },
      digest: async (context) => { const user = requireUser(context); const page = await onDemandDigest({ userId: user.userId,
        locale: context.locale, page: 0, minimumScore: input.digestMinScore, alertScore: input.alertScore, ports: input.delivery });
        await reply(input, context, page.html); },
      search: async (context) => { const user = requireUser(context); const query = context.argument.trim();
        if (!query) { await reply(input, context, context.locale === 'ru'
          ? 'Добавьте запрос после команды: /search должность, компания или навык'
          : 'Add a query after the command: /search role, company, or skill'); return; }
        const results = await input.store.searchMatchedVacancies(user.userId, query, 10);
        if (!results.length) { await reply(input, context, context.locale === 'ru'
          ? 'В ваших совпадениях ничего не найдено. Попробуйте другие слова.'
          : 'Nothing was found in your matches. Try different words.'); return; }
        const lines = results.map((vacancy) => `<b>${vacancy.score === null ? '—' : formatNumber(vacancy.score, context.locale)}/100 — ${escapeHtml(vacancy.name)}</b>\n`
          + `${escapeHtml(vacancy.employer)} · <code>${escapeHtml(vacancy.applyId)}</code> · ${telegramLink(context.locale === 'ru' ? 'открыть' : 'open', vacancy.url)}`);
        for (const message of splitTelegramHtml(lines.flatMap((line, index) => index ? ['', line] : [line]))) await reply(input, context, message); },
      privacy: async (context) => reply(input, context, context.locale === 'ru'
        ? 'Хранятся профиль, резюме, оценки и настройки. /export_me экспортирует данные; /delete_me запрашивает удаление.'
        : 'The service stores your profile, CV, scores, and settings. /export_me exports data; /delete_me requests deletion.'),
      export_me: async (context) => { const user = requireUser(context); const bytes = new TextEncoder().encode(`${JSON.stringify(await input.store.exportUserData(user.userId), null, 2)}\n`);
        await input.transport.sendDocument(user.userId, bytes, 'jobseeker-export.json'); },
      delete_me: async (context) => input.transport.confirmDelete(requireUser(context).userId),
  };
  const rawOwner: Partial<Record<OwnerCommand, (context: RoutedTelegramContext) => Promise<void> | void>> = {
      ok: async (context) => { let target: UserId; try { target = parseUserId(context.argument); } catch { await reply(input, context, 'Usage: /ok USER_ID'); return; }
        const updated = await input.store.setUserStatus(target, 'approved'); await reply(input, context, updated ? `Approved ${target}` : `Unknown ${target}`); },
      revoke: async (context) => { let target: UserId; try { target = parseUserId(context.argument); } catch { await reply(input, context, 'Usage: /revoke USER_ID'); return; }
        const updated = await input.store.setUserStatus(target, 'revoked'); await reply(input, context, updated ? `Revoked ${target}` : `Unknown ${target}`); },
      users: async (context) => { const page = await input.store.listTelegramUsers(100, 0); const ids = page.users.map((user) => String(user.userId));
        const activity = new Map((await input.store.userUsageSummaries()).map((row) => [row.userId, row]));
        const rows = await Promise.all(page.users.map(async (user) => { const counts = activity.get(user.userId);
          const [cv, delivery] = await Promise.all([input.store.getCvHash(user.userId), input.store.getDeliverySettings(user.userId)]);
          const name = user.username ? `@${user.username}` : [user.firstName, user.lastName].filter(Boolean).join(' ');
          const ref = user.isOwner ? '—' : userPrefix(String(user.userId), ids);
          return `<b>${escapeHtml(ref)} · ${escapeHtml(name || String(user.userId))}</b>\n<code>${user.userId}</code> · ${escapeHtml(userStatus(user.status, context.locale))}\n`
            + `CV: ${cv ? (context.locale === 'ru' ? 'да' : 'yes') : (context.locale === 'ru' ? 'нет' : 'no')} · `
            + `${context.locale === 'ru' ? 'оценки' : 'scores'}: ${counts?.scores24h ?? 0}/${counts?.scoresTotal ?? 0} · `
            + `${context.locale === 'ru' ? 'отклики' : 'applications'}: ${counts?.applications24h ?? 0}/${counts?.applicationsTotal ?? 0}\n`
            + `${context.locale === 'ru' ? 'Доставка' : 'Delivery'}: ${deliveryStatus(delivery, context.locale, input.defaultTimezone)}`; }));
        const lines = [`<b>${context.locale === 'ru' ? 'Пользователи' : 'Users'} (${page.total})</b>`, ...rows.flatMap((row) => ['', row]), '',
          context.locale === 'ru' ? 'Оценки и отклики: за 24 часа / за всё время.' : 'Scores and applications: last 24 hours / all time.',
          context.locale === 'ru' ? 'Одобрить: /ok ID. Отозвать: /revoke ID.' : 'Approve: /ok ID. Revoke: /revoke ID.'];
        for (const message of splitTelegramHtml(lines)) await reply(input, context, message); },
      usage: async (context) => { const [summary, settings] = await Promise.all([input.store.llmUsageSummary(),
          input.store.getDeliverySettings(requireUser(context).userId)]);
        for (const message of usageStatus(summary, context.locale, settings?.timezone ?? input.defaultTimezone)) await reply(input, context, message); },
      scraper: async (context) => { const [summary, settings] = await Promise.all([input.store.scraperSummary(),
          input.store.getDeliverySettings(requireUser(context).userId)]);
        for (const message of scraperStatus(summary, input.configuredSources, context.locale, settings?.timezone ?? input.defaultTimezone)) await reply(input, context, message); },
      status: async (context) => reply(input, context, runtimeStatus(input.runtimeStatus(), context.locale)),
  };
  const owner = Object.fromEntries(Object.entries(rawOwner).map(([command, handler]) => [command, async (context: RoutedTelegramContext) => {
    const userId = requireUser(context).userId;
    const generation = await input.ownerMessageHistory?.begin(userId, context.messageId);
    if (generation !== undefined) ownerGenerations.set(context, generation);
    try { await handler?.(context); } finally { ownerGenerations.delete(context); }
  }])) as Partial<Record<OwnerCommand, (context: RoutedTelegramContext) => Promise<void>>>;
  return Object.freeze({ approved: Object.freeze(approved), owner: Object.freeze(owner) });
}

export function applicationCommand(input: CommandPorts, context: RoutedTelegramContext, vacancyId: number,
  artifact: ApplicationArtifact): Promise<'busy' | 'cached' | 'generated'> {
  return deliverApplicationArtifact({ ports: input.applicationActions, worker: input.worker,
    transport: input.applicationTransport, userId: requireUser(context).userId, vacancyId, artifact });
}
