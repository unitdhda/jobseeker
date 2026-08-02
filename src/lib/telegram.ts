import { Bot, InlineKeyboard, InputFile, type Context } from 'grammy';
import type { InputRichBlockTable, InputRichMessage, RichBlockTableCell, RichText } from 'grammy/types';
import { config } from '../config.ts';
import {
  approvedUsers, deleteUserData, digestVacancies, exportUserData, getCvHash, getCvSource, getDeliverySettings,
  getScoredVacancy, getScoredVacancyByApplyId, getTelegramUser, isApprovedUser, latestDigestVacanciesByApplyIdPrefix, listTelegramUsers,
  markAlerted, markApplicationDelivered, markDigested, requestAccess, searchScoredVacancies, setUserStatus,
  skipVacancy, touchTelegramUser, unsentHighScoreVacancies, userUsageSummaries,
  type AlertVacancy, type ScoredVacancy, type TelegramIdentity, type TelegramUser,
} from './database.ts';
import { importCvSource } from './cv-import.ts';
import { refreshUserInWorker, tailorApplicationInWorker } from './job-worker-client.ts';
import { clearApplicationArtifacts } from './application-artifacts.ts';
import { maximumCvBytes } from './cv-limits.ts';
import { readResponseBytes } from './safe-http.ts';
import { errorMessage } from './logging.ts';
import { claimTelegramSession, deleteTelegramSession, getTelegramSession, setTelegramSession } from './telegram-sessions.ts';
import {
  deliverySettingsStatus, normalizeUtcOffset, parseClockMinutes, updateDeliverySettings,
} from './schedules.ts';

let bot: Bot | undefined;
let botConfigured = false;
const activeCvImports = new Set<string>();
const applicationJobs = new Set<string>();
const pendingRefreshHashes = new Map<string, string>();
const refreshingUsers = new Set<string>();
const latestUserPages = new Map<string, string[]>();
type WindowSetup = { step: 'start' | 'end' | 'digest' | 'timezone'; start?: string; end?: string; digest?: string };
const usersPageSize = 8;
const cvUploadSessionTtlMs = 30 * 60_000;
const windowSetupTtlMs = 30 * 60_000;

function getBot(): Bot {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required.');
  return bot ??= new Bot(token);
}
function ownerUserId(): string {
  if (!config.telegramUserId) throw new Error('TELEGRAM_USER_ID is required for the bot owner.');
  return config.telegramUserId;
}
async function targetChat(userId: string): Promise<string> {
  const user = await getTelegramUser(userId);
  if (!user) throw new Error(`Telegram user ${userId} was not found.`);
  return user.chatId;
}
function identity(ctx: Context): TelegramIdentity | null {
  if (!ctx.from || !ctx.chat || ctx.chat.type !== 'private') return null;
  const displayName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || ctx.from.username || String(ctx.from.id);
  return { userId: String(ctx.from.id), chatId: String(ctx.chat.id), username: ctx.from.username, displayName };
}
function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
function sourceLabel(source: string): string {
  return ({ hh: 'HH', habr: 'Habr Career', rabota: 'Работа.ру' } as Record<string, string>)[source] ?? 'источник';
}
function userStatusText(status: TelegramUser['status']): string {
  return ({ unregistered: 'не зарегистрирован', pending: 'на рассмотрении', approved: 'одобрен',
    rejected: 'отклонён', revoked: 'отозван' } as const)[status];
}
function salary(vacancy: ScoredVacancy): string {
  if (vacancy.salaryFrom == null && vacancy.salaryTo == null) return 'не указана';
  const range = vacancy.salaryFrom != null && vacancy.salaryTo != null
    ? `${vacancy.salaryFrom.toLocaleString('ru-RU')}–${vacancy.salaryTo.toLocaleString('ru-RU')}`
    : vacancy.salaryFrom != null ? `от ${vacancy.salaryFrom.toLocaleString('ru-RU')}` : `до ${vacancy.salaryTo?.toLocaleString('ru-RU')}`;
  return `${range} ${vacancy.salaryCurrency ?? ''}${vacancy.salaryGross === false ? ' на руки' : ''}`.trim();
}

export async function sendHighScoreAlert(userId: string, vacancy: AlertVacancy): Promise<void> {
  if (!await isApprovedUser(userId)) throw new Error('User access is not approved.');
  const reasons = vacancy.reasons.slice(0, 3).map((item) => `• ${escapeHtml(item)}`).join('\n');
  const gaps = vacancy.gaps.slice(0, 2).map((item) => `• ${escapeHtml(item)}`).join('\n');
  const text = [
    `<b>${vacancy.score}/100 — ${escapeHtml(vacancy.name)}</b>`,
    `${escapeHtml(vacancy.employer)} · ${escapeHtml(vacancy.area)} · ${sourceLabel(vacancy.source)}`,
    `Направление: ${escapeHtml(vacancy.primaryTrack)} · Зарплата: ${escapeHtml(salary(vacancy))}`,
    `\n<b>Комментарий к оценке</b>\n${escapeHtml(vacancy.summary)}`,
    reasons ? `\n<b>Почему подходит</b>\n${reasons}` : '', gaps ? `\n<b>На что обратить внимание</b>\n${gaps}` : '',
  ].filter(Boolean).join('\n');
  const keyboard = new InlineKeyboard().text('Пропустить', `skip:${vacancy.id}`).text('Откликнуться', `apply:${vacancy.id}`)
    .url(`Открыть ${sourceLabel(vacancy.source)}`, vacancy.url);
  await getBot().api.sendMessage(await targetChat(userId), text, {
    parse_mode: 'HTML', reply_markup: keyboard, link_preview_options: { is_disabled: true },
  });
  await markAlerted(userId, vacancy.id);
}
export async function sendPendingAlerts(userId: string): Promise<number> {
  let sent = 0;
  for (const vacancy of await unsentHighScoreVacancies(userId, config.alertScore)) {
    await sendHighScoreAlert(userId, vacancy); sent++;
  }
  return sent;
}

const headerCell = (text: string, align: 'left' | 'center' | 'right'): RichBlockTableCell => ({
  text: { type: 'bold', text }, is_header: true, align, valign: 'middle',
});
const cell = (text: RichText, align: 'left' | 'center' | 'right' = 'left'): RichBlockTableCell => ({ text, align, valign: 'middle' });
function highlightedApplyId(applyId: string, allApplyIds: string[]): RichText {
  let prefixLength = 1;
  while (prefixLength < applyId.length && allApplyIds.some((other) =>
    other !== applyId && other.startsWith(applyId.slice(0, prefixLength)))) prefixLength++;
  return [{ type: 'bold', text: applyId.slice(0, prefixLength) }, applyId.slice(prefixLength)];
}
export async function sendDailyDigest(userId: string): Promise<number> {
  if (!await isApprovedUser(userId)) throw new Error('User access is not approved.');
  const settings = await getDeliverySettings(userId);
  const vacancies = await digestVacancies(userId, config.digestMinScore, config.alertScore, settings?.lastDigestAt ?? null);
  if (!vacancies.length) return 0;
  const applyIds = vacancies.map((vacancy) => vacancy.applyId);
  for (let offset = 0; offset < vacancies.length; offset += 30) {
    const page = vacancies.slice(offset, offset + 30);
    const table: InputRichBlockTable = {
      type: 'table', is_bordered: true, is_striped: true,
      cells: [[headerCell('ID', 'left'), headerCell('Балл', 'right'), headerCell('Вакансия', 'left'), headerCell('Ссылка', 'center')],
        ...page.map((vacancy) => [cell(highlightedApplyId(vacancy.applyId, applyIds)), cell(String(vacancy.score), 'right'),
          cell(vacancy.name), cell({ type: 'url', text: 'Открыть', url: vacancy.url }, 'center')])],
    };
    await getBot().api.sendRichMessage(await targetChat(userId), { blocks: [
      { type: 'heading', size: 3, text: offset ? 'Ежедневная подборка — продолжение' : 'Ежедневная подборка вакансий' }, table,
      { type: 'paragraph', text: 'Пришлите выделенный префикс или полный ID, чтобы получить адаптированное резюме и сопроводительное письмо.' },
    ] }, { disable_notification: true });
    // Persist each page so a retried delivery does not resend earlier pages.
    await markDigested(userId,page.map((vacancy)=>vacancy.id));
  }
  return vacancies.length;
}

const loaderFrames = ['⋆', '✦', '✧', '✶', '✷'] as const;
const loaderEditIntervalMs = 1_800;
type LoaderTask = 'Адаптирую резюме' | 'Отправляю резюме' | 'Готовлю письмо';
interface ApplicationLoader { setTask(task: LoaderTask): void; stop(): Promise<void> }
interface EditableIndicator { setLabel(label: string): void; stop(): Promise<void> }
export type CycleStatusPhase = 'scraping' | 'filtering' | 'normalization' | 'scoring';
export interface CycleStatus { set(phase: CycleStatusPhase, current?: number, total?: number): void; stop(): Promise<void> }

function retryAfterMilliseconds(error: unknown): number {
  const seconds = Number((error as { parameters?: { retry_after?: number } })?.parameters?.retry_after ?? 0);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 + 250 : 0;
}
function isUnchangedMessageError(error: unknown): boolean {
  return /message is not modified/i.test(error instanceof Error ? error.message : String(error));
}
async function startEditableIndicator(userId: string, initialLabel: string): Promise<EditableIndicator | null> {
  const api = getBot().api; const chat = await targetChat(userId);
  try {
    let label = initialLabel; let frame = 0; let sentText = `${loaderFrames[frame]} ${label}`;
    let updating: Promise<void> | null = null; let blockedUntil = 0; let stopped = false;
    const message = await api.sendMessage(chat, `<code>${sentText}</code>`, { parse_mode: 'HTML' });
    const update = (): void => {
      const next = `${loaderFrames[frame]} ${label}`;
      if (stopped || updating || next === sentText || Date.now() < blockedUntil) return;
      updating = api.editMessageText(chat, message.message_id, `<code>${next}</code>`, { parse_mode: 'HTML' })
        .then(() => { sentText = next; }).catch((error) => {
          const delay = retryAfterMilliseconds(error);
          if (delay) blockedUntil = Date.now() + delay;
          else if (!isUnchangedMessageError(error)) console.warn(`Could not edit task indicator: ${errorMessage(error)}`);
        }).finally(() => { updating = null; });
    };
    const timer = setInterval(() => { frame = (frame + 1) % loaderFrames.length; update(); }, loaderEditIntervalMs);
    return {
      setLabel(nextLabel) { label = nextLabel; frame = 0; update(); },
      async stop() {
        stopped = true; clearInterval(timer); await updating;
        try { await api.deleteMessage(chat, message.message_id); }
        catch (error) {
          const delay = retryAfterMilliseconds(error);
          if (!delay) { console.warn(`Could not remove task indicator: ${errorMessage(error)}`); return; }
          await new Promise((resolve) => setTimeout(resolve, delay));
          await api.deleteMessage(chat, message.message_id).catch((retryError) =>
            console.warn(`Could not remove task indicator after rate-limit retry: ${errorMessage(retryError)}`));
        }
      },
    };
  } catch (error) { console.warn(`Could not start task indicator: ${errorMessage(error)}`); return null; }
}

export async function startCycleStatus(): Promise<CycleStatus | null> {
  if (!process.env.TELEGRAM_BOT_TOKEN || !config.telegramUserId) return null;
  const indicator = await startEditableIndicator(ownerUserId(), 'Ищу вакансии');
  if (!indicator) return null;
  return {
    set(phase, current, total) {
      const label = ({ scraping: 'Ищу вакансии', filtering: 'Фильтрую', normalization: 'Обрабатываю',
        scoring: 'Оцениваю' } as const)[phase];
      indicator.setLabel(current == null || total == null ? label : `${label} (${current}/${total})`);
    },
    stop: () => indicator.stop(),
  };
}
async function startApplicationLoader(userId: string): Promise<ApplicationLoader | null> {
  const indicator = await startEditableIndicator(userId, 'Адаптирую резюме');
  return indicator ? { setTask: (task) => indicator.setLabel(task), stop: () => indicator.stop() } : null;
}

async function generateAndSendApplication(userId: string, vacancyId: number): Promise<void> {
  const jobKey = `${userId}:${vacancyId}`;
  if (applicationJobs.has(jobKey)) return;
  applicationJobs.add(jobKey); let loader: ApplicationLoader | null = null;
  try {
    const vacancy = await getScoredVacancy(userId, vacancyId);
    if (!vacancy) throw new Error('Vacancy not found.');
    loader = await startApplicationLoader(userId);
    const documents = await tailorApplicationInWorker(userId, vacancyId);
    if (!await isApprovedUser(userId)) throw new Error('User access was revoked during application generation.');
    const api = getBot().api; const chat = await targetChat(userId);
    loader?.setTask('Отправляю резюме');
    await api.sendDocument(chat, new InputFile(documents.tailoredCvPdf, `cv-${vacancyId}.pdf`), {
      caption: `Адаптированное резюме — ${vacancy.name}`.slice(0, 1024),
    });
    if (!await isApprovedUser(userId)) throw new Error('User access was revoked during application delivery.');
    loader?.setTask('Готовлю письмо');
    await api.sendMessage(chat, documents.coverLetter, { link_preview_options: { is_disabled: true } });
    await markApplicationDelivered(userId, vacancyId); await loader?.stop();
  } catch (error) {
    await loader?.stop(); console.error(`Application generation failed for ${userId}:${vacancyId}`,
      error instanceof Error ? error.message : String(error));
    if (!await isApprovedUser(userId)) return;
    const vacancy = await getScoredVacancy(userId, vacancyId);
    const keyboard = new InlineKeyboard().text('Попробовать снова', `apply:${vacancyId}`)
      .url(`Открыть ${sourceLabel(vacancy?.source ?? '')}`, vacancy?.url ?? 'https://hh.ru');
    await getBot().api.sendMessage(await targetChat(userId), `Не удалось подготовить документы для вакансии ${vacancyId}. Попробуйте ещё раз.`,
      { reply_markup: keyboard });
  } finally {
    applicationJobs.delete(jobKey); clearApplicationArtifacts(userId, vacancyId);
  }
}

async function cvStatus(userId: string): Promise<string> {
  const cv = await getCvSource(userId);
  return cv ? 'Резюме загружено' : 'Резюме не загружено';
}
async function downloadTelegramFile(fileId: string, declaredSize?: number): Promise<Uint8Array> {
  if (declaredSize != null && declaredSize > maximumCvBytes) throw new Error('CV document exceeds the 20 MB limit.');
  const file = await getBot().api.getFile(fileId);
  if (!file.file_path || file.file_path.includes('..') || file.file_path.startsWith('/')) {
    throw new Error('Telegram returned an invalid file path.');
  }
  const response = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`,
    { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
  return readResponseBytes(response, maximumCvBytes);
}
async function refreshSearchesAfterCvUpload(userId: string): Promise<void> {
  const cvHash = await getCvHash(userId);
  if (!cvHash) return;
  pendingRefreshHashes.set(userId, cvHash);
  if (refreshingUsers.has(userId)) return;
  refreshingUsers.add(userId);
  void (async () => {
    try {
      while (await isApprovedUser(userId)) {
        const requestedHash = pendingRefreshHashes.get(userId);
        if (!requestedHash) break;
        pendingRefreshHashes.delete(userId);
        try {
          const refreshed = await refreshUserInWorker(userId, requestedHash);
          if (!pendingRefreshHashes.has(userId) && await isApprovedUser(userId) && await getCvHash(userId) === requestedHash) {
            await getBot().api.sendMessage(await targetChat(userId),
              `Готово: создано ${refreshed.searchCount} поисковых запросов для ${refreshed.platformCount} платформ. ` +
              'Они будут использованы в следующем цикле поиска.');
          }
        } catch (error) {
          if (!pendingRefreshHashes.has(userId) && await isApprovedUser(userId) && await getCvHash(userId)) {
            console.error(`Search-profile refresh failed for user ${userId}`,
              error instanceof Error ? error.message : String(error));
            await getBot().api.sendMessage(await targetChat(userId),
              'Резюме сохранено, но поисковые настройки пока не удалось обновить. Бот повторит попытку в следующем цикле, когда позволит лимит.');
          }
        }
      }
    } finally {
      pendingRefreshHashes.delete(userId);
      refreshingUsers.delete(userId);
    }
  })();
}

function userPrefix(userId: string, pageIds: string[]): string {
  let length = 1;
  while (length < userId.length && pageIds.some((other) => other !== userId && other.startsWith(userId.slice(0, length)))) length++;
  return userId.slice(0, length);
}
async function usersPage(pageInput: number): Promise<{ richMessage: InputRichMessage; keyboard: InlineKeyboard; ids: string[]; page: number }> {
  const total = (await listTelegramUsers(1, 0)).total; const pages = Math.max(1, Math.ceil(total / usersPageSize));
  const page = Math.max(0, Math.min(pageInput, pages - 1)); const { users } = await listTelegramUsers(usersPageSize, page * usersPageSize);
  const ids = users.map((user) => user.userId);
  const userRows = await Promise.all(users.map(async (user) => {
    const ref = user.isOwner ? '—' : userPrefix(user.userId, ids);
    const name = (user.username ? `@${user.username}` : user.displayName).replace(/\s+/g, ' ').slice(0, 24);
    return [cell(ref), cell(`${name}\n${user.userId}`), cell(userStatusText(user.status)),
      cell(await getCvSource(user.userId) ? 'да' : 'нет', 'center'), cell(await deliverySettingsStatus(user.userId))];
  }));
  const table: InputRichBlockTable = {
    type: 'table', is_bordered: true, is_striped: true,
    cells: [[headerCell('Ссылка', 'left'), headerCell('Пользователь', 'left'), headerCell('Статус', 'left'),
      headerCell('CV', 'center'), headerCell('Доставка', 'left')], ...userRows],
  };
  const richMessage: InputRichMessage = { blocks: [
    { type: 'heading', size: 3, text: `Пользователи — страница ${page + 1}/${pages}` },
    table,
    { type: 'paragraph', text: 'Одобрить: /ok ID или @username. Отозвать: /revoke ССЫЛКА.' },
  ] };
  const keyboard = new InlineKeyboard();
  if (page > 0) keyboard.text('‹ Назад', `users-page:${page - 1}`);
  if (page + 1 < pages) keyboard.text('Далее ›', `users-page:${page + 1}`);
  return { richMessage, keyboard, ids, page };
}
async function showUsers(ctx: Context, page: number, edit = false): Promise<void> {
  const view = await usersPage(page); latestUserPages.set(ownerUserId(), view.ids);
  const options = { reply_markup: view.keyboard };
  if (edit) await ctx.editMessageText(view.richMessage, options);
  else await ctx.replyWithRichMessage(view.richMessage, options);
}
async function resolveUserReference(reference: string): Promise<TelegramUser | null> {
  const pageIds = latestUserPages.get(ownerUserId()) ?? [];
  const pageMatches = pageIds.filter((id) => id === reference || id.startsWith(reference));
  if (pageMatches.length === 1) return getTelegramUser(pageMatches[0]);
  const all = (await listTelegramUsers(10_000, 0)).users.filter((user) => user.userId === reference || user.userId.startsWith(reference));
  return all.length === 1 ? all[0]! : null;
}
async function resolveApprovalReference(reference: string): Promise<TelegramUser | null> {
  const value = reference.trim(); const username = value.replace(/^@/, '').toLowerCase();
  const matches = (await listTelegramUsers(10_000, 0)).users.filter((user) =>
    user.userId === value || user.username?.toLowerCase() === username);
  return matches.length === 1 ? matches[0]! : null;
}
async function deletePersonalData(ctx: Context, confirmation: string): Promise<void> {
  if (!ctx.from) return;
  const userId = String(ctx.from.id);
  if (confirmation.trim().toLowerCase() !== 'confirm') {
    await ctx.reply('Это навсегда удалит ваше резюме, поисковые настройки, оценки, решения, отклики, статистику и настройки доставки. ' +
      'Общая база вакансий останется. Для подтверждения отправьте /delete_me confirm.');
    return;
  }
  if ([...applicationJobs].some((key) => key.startsWith(`${userId}:`)) || activeCvImports.has(userId)
    || refreshingUsers.has(userId)) {
    await ctx.reply('Сейчас выполняется задача с вашим резюме или откликом. Дождитесь её завершения и повторите удаление.'); return;
  }
  await Promise.all(['cv-upload', 'cv-cooldown', 'window-setup'].map((kind) => deleteTelegramSession(userId, kind)));
  pendingRefreshHashes.delete(userId);
  await deleteUserData(userId);
  await ctx.reply('Ваши персональные данные удалены. Доступ к боту сохранён — загрузить новое резюме можно командой /cv.');
}

async function approvedStartText(user: TelegramUser): Promise<string> {
  const ownerCommands = user.isOwner
    ? '\n\nКоманды владельца:\n/ok ID или @username — одобрить доступ\n/users — пользователи\n/revoke ССЫЛКА — отозвать доступ\n/usage — статистика использования'
    : '';
  return `Доступ открыт.\n\n1. Загрузите актуальное резюме командой /cv.\n` +
    `2. Настройте время уведомлений и дайджеста командой /window.\n` +
    `3. Бот будет искать вакансии и оценивать их по вашему резюме.\n\n` +
    `Поиск по найденным вакансиям: /search запрос\nЭкспорт данных: /export_me\nУдаление данных: /delete_me\n` +
    `Как обрабатываются данные: /privacy\n\n${await cvStatus(user.userId)}\nДоставка: ${await deliverySettingsStatus(user.userId)}` + ownerCommands;
}

function configureTelegramBot(): Bot | null {
  if (!process.env.TELEGRAM_BOT_TOKEN) return null;
  const instance = getBot();
  if (botConfigured) return instance;
  const ownerId = ownerUserId();
  if (config.telegramChatId && config.telegramChatId !== ownerId) {
    throw new Error('TELEGRAM_CHAT_ID must be the owner private-chat ID and match TELEGRAM_USER_ID.');
  }
  instance.use(async (ctx, next) => {
    const currentIdentity = identity(ctx);
    if (!currentIdentity) return;
    const user = await touchTelegramUser(currentIdentity);
    const command = ctx.message?.text?.match(/^\/(\w+)/)?.[1]?.toLowerCase();
    if (user.status === 'approved' || user.isOwner || command === 'start' || command === 'request') await next();
    else await ctx.reply(`Доступ: ${userStatusText(user.status)}. Отправьте /request, чтобы запросить доступ у владельца бота.`);
  });
  instance.command('start', async (ctx) => {
    const currentIdentity = identity(ctx); if (!currentIdentity) return;
    const user = await getTelegramUser(currentIdentity.userId);
    if (!user) throw new Error('Telegram user was not persisted.');
    if (user.status === 'approved') await ctx.reply(await approvedStartText(user));
    else await ctx.reply(`Это приватный бот для поиска вакансий. Доступ подтверждает владелец.\n\n` +
      `Ваш статус: ${userStatusText(user.status)}. Отправьте /request, чтобы подать заявку.`);
  });
  instance.command('request', async (ctx) => {
    const currentIdentity = identity(ctx); if (!currentIdentity) return;
    const request = await requestAccess(currentIdentity); const { user } = request;
    if (user.isOwner || user.status === 'approved') { await ctx.reply('У вас уже есть доступ. Отправьте /start, чтобы продолжить.'); return; }
    if (request.retryAfterSeconds > 0) {
      const minutes = Math.max(1, Math.ceil(request.retryAfterSeconds / 60));
      await ctx.reply(`Повторную заявку можно отправить через ${minutes} мин.`); return;
    }
    if (!request.notifyOwner) { await ctx.reply('Заявка уже отправлена и ждёт решения владельца.'); return; }
    const keyboard = new InlineKeyboard().text('Одобрить', `access:approve:${user.userId}`).text('Отклонить', `access:reject:${user.userId}`);
    await getBot().api.sendMessage(await targetChat(ownerUserId()),
      `<b>Новая заявка на доступ</b>\n${escapeHtml(user.displayName)}${user.username ? ` (@${escapeHtml(user.username)})` : ''}\n` +
      `ID пользователя: <code>${user.userId}</code>`, { parse_mode: 'HTML', reply_markup: keyboard });
    await ctx.reply('Заявка отправлена. Бот сообщит, когда владелец примет решение.');
  });
  instance.callbackQuery(/^access:(approve|reject):(\d+)$/, async (ctx) => {
    if (String(ctx.from.id) !== ownerUserId()) { await ctx.answerCallbackQuery({ text: 'Только для владельца' }); return; }
    const action = ctx.match[1]; const userId = ctx.match[2];
    const current = await getTelegramUser(userId);
    if (!current) { await ctx.answerCallbackQuery({ text: 'Пользователь не найден' }); return; }
    if (current.status !== 'pending') {
      await ctx.answerCallbackQuery({ text: `Заявка уже обработана: ${userStatusText(current.status)}` });
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
      return;
    }
    const user = await setUserStatus(userId, action === 'approve' ? 'approved' : 'rejected');
    if (!user) throw new Error('Telegram user disappeared during access update.');
    await ctx.answerCallbackQuery({ text: action === 'approve' ? 'Доступ одобрен' : 'Заявка отклонена' });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    await getBot().api.sendMessage(user.chatId, action === 'approve'
      ? 'Доступ одобрен. Отправьте /start, чтобы начать настройку.'
      : 'Заявка отклонена. Позже вы сможете снова отправить /request.');
  });
  instance.command('ok', async (ctx) => {
    if (String(ctx.from?.id) !== ownerUserId()) { await ctx.reply('Эта команда доступна только владельцу.'); return; }
    const reference = ctx.match.trim();
    if (!reference) { await ctx.reply('Укажите ID или username: /ok 123456789 или /ok @username'); return; }
    const user = await resolveApprovalReference(reference);
    if (!user) { await ctx.reply('Пользователь не найден. Он должен сначала открыть бота или отправить /request.'); return; }
    if (user.isOwner || user.status === 'approved') { await ctx.reply('У этого пользователя уже есть доступ.'); return; }
    await setUserStatus(user.userId, 'approved');
    await ctx.reply(`Доступ одобрен: ${user.username ? `@${user.username}` : user.userId}.`);
    try { await getBot().api.sendMessage(user.chatId, 'Доступ одобрен. Отправьте /start, чтобы начать настройку.'); }
    catch (error) {
      console.error(`Could not notify approved user ${user.userId}: ${errorMessage(error)}`);
      await ctx.reply('Доступ сохранён, но уведомить пользователя не удалось.');
    }
  });
  instance.command('users', async (ctx) => {
    if (String(ctx.from?.id) !== ownerUserId()) { await ctx.reply('Эта команда доступна только владельцу.'); return; }
    const page = Math.max(0, Number.parseInt(ctx.match.trim(), 10) - 1 || 0); await showUsers(ctx, page);
  });
  instance.callbackQuery(/^users-page:(\d+)$/, async (ctx) => {
    if (String(ctx.from.id) !== ownerUserId()) { await ctx.answerCallbackQuery({ text: 'Только для владельца' }); return; }
    await ctx.answerCallbackQuery(); await showUsers(ctx, Number(ctx.match[1]), true);
  });
  instance.command('revoke', async (ctx) => {
    if (String(ctx.from?.id) !== ownerUserId()) { await ctx.reply('Эта команда доступна только владельцу.'); return; }
    const reference = ctx.match.trim();
    if (!reference) { await ctx.reply('Сначала откройте /users, затем отправьте /revoke ССЫЛКА.'); return; }
    const user = await resolveUserReference(reference);
    if (!user) { await ctx.reply('Ссылка не найдена или неоднозначна. Откройте /users и используйте ссылку из таблицы.'); return; }
    if (user.isOwner) { await ctx.reply('Нельзя отозвать доступ у владельца.'); return; }
    await setUserStatus(user.userId, 'revoked');
    await Promise.all(['cv-upload', 'window-setup'].map((kind) => deleteTelegramSession(user.userId, kind)));
    pendingRefreshHashes.delete(user.userId);
    await ctx.reply(`Доступ пользователя ${user.userId} отозван.`);
    await getBot().api.sendMessage(user.chatId, 'Ваш доступ к боту отозван. Позже можно снова отправить /request.');
  });
  instance.command('usage', async (ctx) => {
    if (String(ctx.from?.id) !== ownerUserId()) { await ctx.reply('Эта команда доступна только владельцу.'); return; }
    const rows = await userUsageSummaries();
    const lines = rows.map((row) => `${row.userId.padEnd(14)} ${String(row.scores24h).padStart(4)}/${String(row.scoresTotal).padEnd(5)} ` +
      `${String(row.applications24h).padStart(3)}/${String(row.applicationsTotal).padEnd(4)} ${row.displayName.slice(0, 18)}`);
    await ctx.reply(`<b>Использование — 24 часа / всё время</b>\n<pre>${escapeHtml(['ID              Оценки      Отклики  Пользователь', ...lines].join('\n'))}</pre>`,
      { parse_mode: 'HTML' });
  });
  instance.command('search', async (ctx) => {
    const query = ctx.match.trim();
    if (!query) { await ctx.reply('Добавьте запрос после команды: /search должность, компания или навык'); return; }
    const results = await searchScoredVacancies(String(ctx.from!.id), query);
    if (!results.length) { await ctx.reply('В оценённых вакансиях ничего не найдено. Попробуйте другие слова.'); return; }
    const text = results.map((vacancy) => `<b>${vacancy.score}/100 — ${escapeHtml(vacancy.name)}</b>\n` +
      `${escapeHtml(vacancy.employer)} · <code>${vacancy.applyId}</code> · <a href="${escapeHtml(vacancy.url)}">открыть</a>`).join('\n\n');
    await ctx.reply(text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  });
  instance.command('export_me', async (ctx) => {
    const userId = String(ctx.from!.id);
    const bytes = Buffer.from(`${JSON.stringify(await exportUserData(userId), null, 2)}\n`);
    await ctx.replyWithDocument(new InputFile(bytes, `jobseeker-export-${new Date().toISOString().slice(0, 10)}.json`));
  });
  instance.command('delete_me', async (ctx) => deletePersonalData(ctx, ctx.match));
  instance.hears(/^\/delete-me(?:@\w+)?(?:\s+(.*))?$/i, async (ctx) => deletePersonalData(ctx, ctx.match[1] ?? ''));
  instance.command('window', async (ctx) => {
    const userId = String(ctx.from!.id); const action = ctx.match.trim().toLowerCase();
    if (action === 'status') { await ctx.reply(`Настройки доставки: ${await deliverySettingsStatus(userId)}`); return; }
    if (action === 'cancel') {
      await deleteTelegramSession(userId, 'window-setup'); await ctx.reply('Настройка отменена.'); return;
    }
    if (action) { await ctx.reply('Отправьте /window для настройки, /window status для просмотра или /window cancel для отмены.'); return; }
    await setTelegramSession(userId, 'window-setup', { step: 'start' } satisfies WindowSetup, windowSetupTtlMs);
    await ctx.reply(`Сейчас: ${await deliverySettingsStatus(userId)}\n\n1/4 Во сколько начинать уведомления? Отправьте время в формате ЧЧ:ММ, например 09:00.`);
  });
  instance.on('message:text', async (ctx, next) => {
    const userId = String(ctx.from.id); const setup = await getTelegramSession<WindowSetup>(userId, 'window-setup');
    if (!setup) { await next(); return; }
    const value = ctx.message.text.trim();
    try {
      if (setup.step === 'start') {
        parseClockMinutes(value); await setTelegramSession(userId, 'window-setup', { step: 'end', start: value } satisfies WindowSetup, windowSetupTtlMs);
        await ctx.reply('2/4 Во сколько заканчивать уведомления? Формат ЧЧ:ММ, например 22:00.');
      } else if (setup.step === 'end') {
        parseClockMinutes(value);
        if (parseClockMinutes(setup.start!) === parseClockMinutes(value)) throw new Error('Время начала и окончания должно отличаться.');
        await setTelegramSession(userId, 'window-setup', { ...setup, step: 'digest', end: value }, windowSetupTtlMs);
        await ctx.reply('3/4 Во сколько присылать ежедневную подборку? Формат ЧЧ:ММ, например 09:30.');
      } else if (setup.step === 'digest') {
        parseClockMinutes(value); await setTelegramSession(userId, 'window-setup', { ...setup, step: 'timezone', digest: value }, windowSetupTtlMs);
        await ctx.reply('4/4 Укажите смещение от UTC: например +3, -5 или +3:30.');
      } else {
        const timezone = normalizeUtcOffset(value);
        await updateDeliverySettings(userId, setup.start!, setup.end!, setup.digest!, timezone);
        await deleteTelegramSession(userId, 'window-setup');
        await ctx.reply(`Готово. ${await deliverySettingsStatus(userId)}`);
      }
    } catch (error) { await ctx.reply(error instanceof Error ? error.message : String(error)); }
  });
  instance.command('privacy', async (ctx) => {
    await ctx.reply('Как обрабатываются данные:\n\n• В приватной базе хранятся текст и структура резюме, поисковые настройки, числовые оценки, статистика и состояние доставки.\n• Текст резюме и вакансий передаётся настроенной языковой модели для поиска, оценки и подготовки отклика.\n• Исходные файлы, готовые PDF, сопроводительные письма и завершённые диалоги с моделью не сохраняются.\n• Пояснение к высокой оценке хранится только до отправки уведомления.\n• Экспорт: /export_me. Полное удаление: /delete_me confirm.\n\nЗагружая резюме через /cv, вы соглашаетесь с этой обработкой.');
  });
  instance.command('cv', async (ctx) => {
    const userId = String(ctx.from!.id);
    if (ctx.match.trim()) { await ctx.reply('Просто отправьте команду /cv без дополнительных параметров.'); return; }
    if (!await getTelegramSession(userId, 'cv-upload')) {
      const cooldownMs = config.cvUploadSessionCooldownMinutes * 60_000;
      const cooldown = await claimTelegramSession(userId, 'cv-cooldown', {}, cooldownMs);
      if (!cooldown.claimed) {
        const remaining = cooldown.expiresAt.getTime() - Date.now();
        await ctx.reply(`Новую загрузку можно начать через ${Math.max(1, Math.ceil(remaining / 60_000))} мин.`);
        return;
      }
    }
    await setTelegramSession(userId, 'cv-upload', {}, cvUploadSessionTtlMs);
    await ctx.reply(`${await cvStatus(userId)}.\n\nПришлите актуальное резюме одним файлом: PDF, Markdown, TXT или DOCX до 20 МБ. ` +
      'Новое резюме заменит предыдущее. Загружая файл, вы соглашаетесь с условиями /privacy.');
  });
  instance.on('message:document', async (ctx) => {
    const userId = String(ctx.from.id);
    if (!await getTelegramSession(userId, 'cv-upload')) { await ctx.reply('Сначала отправьте /cv, затем прикрепите файл с резюме.'); return; }
    if (activeCvImports.has(userId)) { await ctx.reply('Предыдущий файл ещё проверяется. Пожалуйста, подождите.'); return; }
    activeCvImports.add(userId);
    try {
      const document = ctx.message.document;
      const filename = document.file_name ?? 'cv';
      if (document.file_size != null && document.file_size > maximumCvBytes) {
        await ctx.reply('Файл больше 20 МБ. Пришлите файл меньшего размера.'); return;
      }
      const supportedExtension = /\.(?:pdf|md|markdown|txt|docx)$/i.test(filename);
      const unsupportedExtension = /\.[a-z0-9]{1,10}$/i.test(filename) && !supportedExtension;
      const supportedMediaType = ['application/pdf', 'text/markdown', 'text/plain',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(document.mime_type ?? '');
      if (unsupportedExtension || (!supportedExtension && !supportedMediaType)) {
        await ctx.reply('Поддерживаются только PDF, Markdown, TXT и DOCX.'); return;
      }
      const bytes = await downloadTelegramFile(document.file_id, document.file_size);
      await importCvSource(userId, filename, document.mime_type, bytes);
      await deleteTelegramSession(userId, 'cv-upload');
      await ctx.reply(`Резюме сохранено. ${await cvStatus(userId)}.\nОбновляю настройки поиска…`);
      await refreshSearchesAfterCvUpload(userId);
    } catch (error) {
      console.error(`CV import failed for user ${userId}: ${errorMessage(error)}`);
      if (await isApprovedUser(userId)) await ctx.reply('Не удалось обработать файл. Проверьте формат и размер, затем попробуйте снова.');
    } finally { activeCvImports.delete(userId); }
  });
  instance.hears(/^\s*([a-zA-Z]{1,6})\s*$/, async (ctx) => {
    if (!ctx.from) return;
    const userId = String(ctx.from.id); const reference = ctx.match[1].toLowerCase();
    const exact = reference.length === 6 ? await getScoredVacancyByApplyId(userId, reference) : null;
    const matches: ScoredVacancy[] = reference.length === 6 ? (exact ? [exact] : [])
      : await latestDigestVacanciesByApplyIdPrefix(userId, reference);
    if (!matches.length) { await ctx.reply(`В последней подборке нет вакансии с ID ${reference}.`); return; }
    if (matches.length > 1) { await ctx.reply(`Префикс ${reference} подходит к нескольким вакансиям. Пришлите больше букв.`); return; }
    const vacancy = matches[0]; const key = `${userId}:${vacancy.id}`;
    if (applicationJobs.has(key)) { await ctx.reply(`Документы для ${vacancy.applyId} уже готовятся.`); return; }
    void generateAndSendApplication(userId, vacancy.id);
  });
  instance.callbackQuery(/^skip:(\d+)$/, async (ctx) => {
    const userId = String(ctx.from.id); const id = Number(ctx.match[1]); await skipVacancy(userId, id);
    await ctx.answerCallbackQuery({ text: 'Вакансия пропущена' }); await ctx.deleteMessage();
  });
  instance.callbackQuery(/^apply:(\d+)$/, async (ctx) => {
    const userId = String(ctx.from.id); const id = Number(ctx.match[1]);
    await ctx.answerCallbackQuery({ text: 'Готовлю резюме и письмо…' });
    const vacancy = await getScoredVacancy(userId, id);
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard()
      .url(`Открыть ${sourceLabel(vacancy?.source ?? '')}`, vacancy?.url ?? 'https://hh.ru') });
    void generateAndSendApplication(userId, id);
  });
  instance.catch((error) => console.error(`Telegram bot error: ${errorMessage(error.error)}`));
  botConfigured = true;
  return instance;
}

async function registerTelegramCommands(instance: Bot): Promise<void> {
  await instance.api.deleteMyCommands();
  await instance.api.setMyCommands([
    { command: 'start', description: 'Начало работы и статус' },
    { command: 'request', description: 'Запросить доступ' },
    { command: 'cv', description: 'Загрузить или заменить резюме' },
    { command: 'privacy', description: 'Как обрабатываются данные' },
    { command: 'window', description: 'Настроить уведомления и дайджест' },
    { command: 'search', description: 'Поиск по оценённым вакансиям' },
    { command: 'export_me', description: 'Экспортировать свои данные' },
    { command: 'delete_me', description: 'Удалить свои данные' },
  ]);
}

export function startTelegramBot(): void {
  const instance = configureTelegramBot();
  if (!instance || config.telegramMode !== 'polling') return;
  void instance.start({ allowed_updates: ['message', 'callback_query'], onStart: async () => {
    await registerTelegramCommands(instance);
    console.info('Telegram bot started; multi-user commands registered');
  } });
}

export async function initializeTelegramWebhookHandler(): Promise<void> {
  if (config.telegramMode !== 'webhook') return;
  const instance = configureTelegramBot();
  if (!instance) throw new Error('TELEGRAM_BOT_TOKEN is required for webhook mode.');
  await instance.init();
}

export async function handleTelegramWebhookUpdate(update: unknown): Promise<void> {
  if (config.telegramMode !== 'webhook') throw new Error('Telegram webhook mode is not enabled.');
  const instance = configureTelegramBot();
  if (!instance) throw new Error('TELEGRAM_BOT_TOKEN is required for webhook mode.');
  if (!instance.botInfo) await instance.init();
  await instance.handleUpdate(update as Parameters<Bot['handleUpdate']>[0]);
}

export async function initializeTelegramWebhookMode(): Promise<void> {
  await initializeTelegramWebhookHandler();
  if (config.telegramMode !== 'webhook') return;
  const instance = configureTelegramBot()!;
  await registerTelegramCommands(instance);
  console.info('Telegram webhook handlers initialized; multi-user commands registered');
}

export async function stopTelegramBot(): Promise<void> {
  if (bot?.isRunning()) await bot.stop();
}
