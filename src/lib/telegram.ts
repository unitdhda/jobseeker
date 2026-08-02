import { Bot, InlineKeyboard, InputFile, type Context } from 'grammy';
import type { InputRichBlockTable, RichBlockTableCell, RichText } from 'grammy/types';
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
import {
  deliverySettingsStatus, normalizeUtcOffset, parseClockMinutes, updateDeliverySettings,
} from './schedules.ts';

let bot: Bot | undefined;
const pendingCvUpload = new Set<string>();
const activeCvImports = new Set<string>();
const lastCvSessions = new Map<string, number>();
const applicationJobs = new Set<string>();
const pendingRefreshHashes = new Map<string, string>();
const refreshingUsers = new Set<string>();
const latestUserPages = new Map<string, string[]>();
type WindowSetup = { step: 'start' | 'end' | 'digest' | 'timezone'; start?: string; end?: string; digest?: string };
const pendingWindowSetup = new Map<string, WindowSetup>();
const usersPageSize = 8;

function getBot(): Bot {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required.');
  return bot ??= new Bot(token);
}
function ownerUserId(): string {
  if (!config.telegramUserId) throw new Error('TELEGRAM_USER_ID is required for the bot owner.');
  return config.telegramUserId;
}
function targetChat(userId: string): string {
  const user = getTelegramUser(userId);
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
  return ({ hh: 'HH', hirehi: 'HireHi', habr: 'Habr Career', getmatch: 'getmatch', geekjob: 'GeekJob',
    superjob: 'SuperJob', avito: 'Avito', rabota: 'Работа.ру' } as Record<string, string>)[source] ?? 'source';
}
function salary(vacancy: ScoredVacancy): string {
  if (vacancy.salaryFrom == null && vacancy.salaryTo == null) return 'not specified';
  const range = vacancy.salaryFrom != null && vacancy.salaryTo != null
    ? `${vacancy.salaryFrom.toLocaleString()}–${vacancy.salaryTo.toLocaleString()}`
    : vacancy.salaryFrom != null ? `from ${vacancy.salaryFrom.toLocaleString()}` : `to ${vacancy.salaryTo?.toLocaleString()}`;
  return `${range} ${vacancy.salaryCurrency ?? ''}${vacancy.salaryGross === false ? ' net' : ''}`.trim();
}

export async function sendHighScoreAlert(userId: string, vacancy: AlertVacancy): Promise<void> {
  if (!isApprovedUser(userId)) throw new Error('User access is not approved.');
  const reasons = vacancy.reasons.slice(0, 3).map((item) => `• ${escapeHtml(item)}`).join('\n');
  const gaps = vacancy.gaps.slice(0, 2).map((item) => `• ${escapeHtml(item)}`).join('\n');
  const text = [
    `<b>${vacancy.score}/100 — ${escapeHtml(vacancy.name)}</b>`,
    `${escapeHtml(vacancy.employer)} · ${escapeHtml(vacancy.area)} · ${sourceLabel(vacancy.source)}`,
    `Track: ${escapeHtml(vacancy.primaryTrack)} · Salary: ${escapeHtml(salary(vacancy))}`,
    `\n<b>Score reasoning</b>\n${escapeHtml(vacancy.summary)}`,
    reasons ? `\n<b>Why it fits</b>\n${reasons}` : '', gaps ? `\n<b>Gaps</b>\n${gaps}` : '',
  ].filter(Boolean).join('\n');
  const keyboard = new InlineKeyboard().text('Skip', `skip:${vacancy.id}`).text('Apply', `apply:${vacancy.id}`)
    .url(`Open ${sourceLabel(vacancy.source)}`, vacancy.url);
  await getBot().api.sendMessage(targetChat(userId), text, {
    parse_mode: 'HTML', reply_markup: keyboard, link_preview_options: { is_disabled: true },
  });
  markAlerted(userId, vacancy.id);
}
export async function sendPendingAlerts(userId: string): Promise<number> {
  let sent = 0;
  for (const vacancy of unsentHighScoreVacancies(userId, config.alertScore)) {
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
  if (!isApprovedUser(userId)) throw new Error('User access is not approved.');
  const vacancies = digestVacancies(userId, config.digestMinScore, config.alertScore,
    getDeliverySettings(userId)?.lastDigestAt ?? null);
  if (!vacancies.length) return 0;
  const applyIds = vacancies.map((vacancy) => vacancy.applyId);
  for (let offset = 0; offset < vacancies.length; offset += 30) {
    const page = vacancies.slice(offset, offset + 30);
    const table: InputRichBlockTable = {
      type: 'table', is_bordered: true, is_striped: true,
      cells: [[headerCell('Apply ID', 'left'), headerCell('Score', 'right'), headerCell('Vacancy', 'left'), headerCell('Link', 'center')],
        ...page.map((vacancy) => [cell(highlightedApplyId(vacancy.applyId, applyIds)), cell(String(vacancy.score), 'right'),
          cell(vacancy.name), cell({ type: 'url', text: 'Open', url: vacancy.url }, 'center')])],
    };
    await getBot().api.sendRichMessage(targetChat(userId), { blocks: [
      { type: 'heading', size: 3, text: offset ? 'Daily vacancy digest — continued' : 'Daily vacancy digest' }, table,
      { type: 'paragraph', text: 'Send the bold prefix or full Apply ID to receive the tailored CV and supporting cover letter.' },
    ] }, { disable_notification: true });
  }
  markDigested(userId, vacancies.map((vacancy) => vacancy.id));
  return vacancies.length;
}

const loaderFrames = ['⋆', '✦', '✧', '✶', '✷'] as const;
const loaderEditIntervalMs = 1_800;
type LoaderTask = 'Tailoring CV' | 'Sending CV' | 'Cover letter';
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
  const api = getBot().api; const chat = targetChat(userId);
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
  const indicator = await startEditableIndicator(ownerUserId(), 'Scraping');
  if (!indicator) return null;
  return {
    set(phase, current, total) {
      const label = phase[0].toUpperCase() + phase.slice(1);
      indicator.setLabel(current == null || total == null ? label : `${label} (${current}/${total})`);
    },
    stop: () => indicator.stop(),
  };
}
async function startApplicationLoader(userId: string): Promise<ApplicationLoader | null> {
  const indicator = await startEditableIndicator(userId, 'Tailoring CV');
  return indicator ? { setTask: (task) => indicator.setLabel(task), stop: () => indicator.stop() } : null;
}

async function generateAndSendApplication(userId: string, vacancyId: number): Promise<void> {
  const jobKey = `${userId}:${vacancyId}`;
  if (applicationJobs.has(jobKey)) return;
  applicationJobs.add(jobKey); let loader: ApplicationLoader | null = null;
  try {
    const vacancy = getScoredVacancy(userId, vacancyId);
    if (!vacancy) throw new Error('Vacancy not found.');
    loader = await startApplicationLoader(userId);
    const documents = await tailorApplicationInWorker(userId, vacancyId);
    if (!isApprovedUser(userId)) throw new Error('User access was revoked during application generation.');
    const api = getBot().api; const chat = targetChat(userId);
    loader?.setTask('Sending CV');
    await api.sendDocument(chat, new InputFile(documents.tailoredCvPdf, `cv-${vacancyId}.pdf`), {
      caption: `Tailored CV — ${vacancy.name}`.slice(0, 1024),
    });
    if (!isApprovedUser(userId)) throw new Error('User access was revoked during application delivery.');
    loader?.setTask('Cover letter');
    await api.sendMessage(chat, documents.coverLetter, { link_preview_options: { is_disabled: true } });
    markApplicationDelivered(userId, vacancyId); await loader?.stop();
  } catch (error) {
    await loader?.stop(); console.error(`Application generation failed for ${userId}:${vacancyId}`,
      error instanceof Error ? error.message : String(error));
    if (!isApprovedUser(userId)) return;
    const vacancy = getScoredVacancy(userId, vacancyId);
    const keyboard = new InlineKeyboard().text('Retry Apply', `apply:${vacancyId}`)
      .url(`Open ${sourceLabel(vacancy?.source ?? '')}`, vacancy?.url ?? 'https://hh.ru');
    await getBot().api.sendMessage(targetChat(userId), `Could not prepare application documents for vacancy ${vacancyId}. You can retry.`,
      { reply_markup: keyboard });
  } finally {
    applicationJobs.delete(jobKey); clearApplicationArtifacts(userId, vacancyId);
  }
}

function cvStatus(userId: string): string {
  const cv = getCvSource(userId);
  return cv ? 'CV source: ready' : 'CV source: missing';
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
function refreshSearchesAfterCvUpload(userId: string): void {
  const cvHash = getCvHash(userId);
  if (!cvHash) return;
  pendingRefreshHashes.set(userId, cvHash);
  if (refreshingUsers.has(userId)) return;
  refreshingUsers.add(userId);
  void (async () => {
    try {
      while (isApprovedUser(userId)) {
        const requestedHash = pendingRefreshHashes.get(userId);
        if (!requestedHash) break;
        pendingRefreshHashes.delete(userId);
        try {
          const refreshed = await refreshUserInWorker(userId, requestedHash);
          if (!pendingRefreshHashes.has(userId) && isApprovedUser(userId) && getCvHash(userId) === requestedHash) {
            await getBot().api.sendMessage(targetChat(userId),
              `Refreshed ${refreshed.searchCount} searches across ${refreshed.platformCount} platforms. ` +
              'The next scheduled shared scan will use them.');
          }
        } catch (error) {
          if (!pendingRefreshHashes.has(userId) && isApprovedUser(userId) && getCvHash(userId)) {
            console.error(`Search-profile refresh failed for user ${userId}`,
              error instanceof Error ? error.message : String(error));
            await getBot().api.sendMessage(targetChat(userId),
              'The CV source was saved, but profile generation was deferred or failed. The next scheduled scan will retry within your daily limit.');
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
function usersPage(pageInput: number): { text: string; keyboard: InlineKeyboard; ids: string[]; page: number } {
  const total = listTelegramUsers(1, 0).total; const pages = Math.max(1, Math.ceil(total / usersPageSize));
  const page = Math.max(0, Math.min(pageInput, pages - 1)); const { users } = listTelegramUsers(usersPageSize, page * usersPageSize);
  const ids = users.map((user) => user.userId);
  const lines = users.map((user) => {
    const ref = user.isOwner ? '—' : userPrefix(user.userId, ids);
    const name = (user.username ? `@${user.username}` : user.displayName).replace(/\s+/g, ' ').slice(0, 16);
    const cv = getCvSource(user.userId) ? 'yes' : 'no';
    const delivery = deliverySettingsStatus(user.userId).replace('Europe/', '').slice(0, 44);
    return `${ref.padEnd(7)} ${user.status.padEnd(11)} ${user.userId.padEnd(13)} ${cv.padEnd(3)} ${delivery.padEnd(44)} ${name}`;
  });
  const text = `<b>Users — page ${page + 1}/${pages}</b>\n<pre>${escapeHtml(['Ref     Status      User ID       CV  Delivery                                     User', ...lines].join('\n'))}</pre>` +
    `Revoke from this page with <code>/revoke REF</code>.`;
  const keyboard = new InlineKeyboard();
  if (page > 0) keyboard.text('‹ Previous', `users-page:${page - 1}`);
  if (page + 1 < pages) keyboard.text('Next ›', `users-page:${page + 1}`);
  return { text, keyboard, ids, page };
}
async function showUsers(ctx: Context, page: number, edit = false): Promise<void> {
  const view = usersPage(page); latestUserPages.set(ownerUserId(), view.ids);
  const options = { parse_mode: 'HTML' as const, reply_markup: view.keyboard };
  if (edit) await ctx.editMessageText(view.text, options); else await ctx.reply(view.text, options);
}
function resolveUserReference(reference: string): TelegramUser | null {
  const pageIds = latestUserPages.get(ownerUserId()) ?? [];
  const pageMatches = pageIds.filter((id) => id === reference || id.startsWith(reference));
  if (pageMatches.length === 1) return getTelegramUser(pageMatches[0]);
  const all = listTelegramUsers(10_000, 0).users.filter((user) => user.userId === reference || user.userId.startsWith(reference));
  return all.length === 1 ? all[0] : null;
}
async function deletePersonalData(ctx: Context, confirmation: string): Promise<void> {
  if (!ctx.from) return;
  const userId = String(ctx.from.id);
  if (confirmation.trim().toLowerCase() !== 'confirm') {
    await ctx.reply('This permanently deletes your CV source, profiles, scores, decisions, applications, usage, and settings. ' +
      'Shared vacancies remain. Send /delete_me confirm (or /delete-me confirm) to continue.');
    return;
  }
  if ([...applicationJobs].some((key) => key.startsWith(`${userId}:`)) || activeCvImports.has(userId)
    || refreshingUsers.has(userId)) {
    await ctx.reply('Wait for your active CV/profile/application task to finish, then retry deletion.'); return;
  }
  pendingCvUpload.delete(userId);
  pendingRefreshHashes.delete(userId);
  pendingWindowSetup.delete(userId);
  deleteUserData(userId);
  await ctx.reply('Your personal Jobseeker data was deleted. Your approved access remains; use /cv to start again.');
}

function approvedStartText(user: TelegramUser): string {
  const ownerCommands = user.isOwner
    ? '\n\nOwner commands:\n/users — review users\n/revoke REF — revoke access\n/usage — show per-user usage'
    : '';
  return `Jobseeker access: approved.\n\nUpload one authoritative CV in any language with /cv. Shared vacancies are scored privately against it. ` +
    `Before uploading, use /privacy to review storage, model-provider processing, retention, export, and deletion. ` +
    `Use /search to search your scored vacancies, /export_me to export personal data, and /delete_me to erase it. ` +
    `Use /window for a four-step notification and digest schedule setup. ` +
    `Send an Apply ID from a digest to generate application documents.\n\n${cvStatus(user.userId)}\nDelivery: ${deliverySettingsStatus(user.userId)}` + ownerCommands;
}

export function startTelegramBot(): void {
  if (!process.env.TELEGRAM_BOT_TOKEN || !config.telegramPolling) return;
  const ownerId = ownerUserId();
  if (config.telegramChatId && config.telegramChatId !== ownerId) {
    throw new Error('TELEGRAM_CHAT_ID must be the owner private-chat ID and match TELEGRAM_USER_ID.');
  }
  const instance = getBot();
  instance.use(async (ctx, next) => {
    const currentIdentity = identity(ctx);
    if (!currentIdentity) return;
    const user = touchTelegramUser(currentIdentity);
    const command = ctx.message?.text?.match(/^\/(\w+)/)?.[1]?.toLowerCase();
    if (user.status === 'approved' || user.isOwner || command === 'start' || command === 'request') await next();
    else await ctx.reply(`Access is ${user.status}. Use /request to request manual approval from the bot owner.`);
  });
  instance.command('start', async (ctx) => {
    const currentIdentity = identity(ctx); if (!currentIdentity) return;
    const user = getTelegramUser(currentIdentity.userId)!;
    if (user.status === 'approved') await ctx.reply(approvedStartText(user));
    else await ctx.reply(`This is a private multi-user vacancy assistant. Access requires manual owner approval.\n` +
      `Your status: ${user.status}. Use /request to submit or resubmit a request.`);
  });
  instance.command('request', async (ctx) => {
    const currentIdentity = identity(ctx); if (!currentIdentity) return;
    const request = requestAccess(currentIdentity); const { user } = request;
    if (user.isOwner || user.status === 'approved') { await ctx.reply('Your access is already approved.'); return; }
    if (request.retryAfterSeconds > 0) {
      const minutes = Math.max(1, Math.ceil(request.retryAfterSeconds / 60));
      await ctx.reply(`Please wait ${minutes} minute(s) before submitting another access request.`); return;
    }
    if (!request.notifyOwner) { await ctx.reply('Your access request is already pending owner review.'); return; }
    const keyboard = new InlineKeyboard().text('Approve', `access:approve:${user.userId}`).text('Reject', `access:reject:${user.userId}`);
    await getBot().api.sendMessage(targetChat(ownerUserId()),
      `<b>Access request</b>\n${escapeHtml(user.displayName)}${user.username ? ` (@${escapeHtml(user.username)})` : ''}\n` +
      `User ID: <code>${user.userId}</code>`, { parse_mode: 'HTML', reply_markup: keyboard });
    await ctx.reply('Access request sent to the owner. You will be notified after review.');
  });
  instance.callbackQuery(/^access:(approve|reject):(\d+)$/, async (ctx) => {
    if (String(ctx.from.id) !== ownerUserId()) { await ctx.answerCallbackQuery({ text: 'Owner only' }); return; }
    const action = ctx.match[1]; const userId = ctx.match[2];
    const current = getTelegramUser(userId);
    if (!current) { await ctx.answerCallbackQuery({ text: 'User not found' }); return; }
    if (current.status !== 'pending') {
      await ctx.answerCallbackQuery({ text: `Request is already ${current.status}` });
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
      return;
    }
    const user = setUserStatus(userId, action === 'approve' ? 'approved' : 'rejected')!;
    await ctx.answerCallbackQuery({ text: action === 'approve' ? 'Approved' : 'Rejected' });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    await getBot().api.sendMessage(user.chatId, action === 'approve'
      ? 'Your access was approved. Use /start for setup instructions.'
      : 'Your access request was rejected. You may use /request to request access again later.');
  });
  instance.command('users', async (ctx) => {
    if (String(ctx.from?.id) !== ownerUserId()) { await ctx.reply('Owner only.'); return; }
    const page = Math.max(0, Number.parseInt(ctx.match.trim(), 10) - 1 || 0); await showUsers(ctx, page);
  });
  instance.callbackQuery(/^users-page:(\d+)$/, async (ctx) => {
    if (String(ctx.from.id) !== ownerUserId()) { await ctx.answerCallbackQuery({ text: 'Owner only' }); return; }
    await ctx.answerCallbackQuery(); await showUsers(ctx, Number(ctx.match[1]), true);
  });
  instance.command('revoke', async (ctx) => {
    if (String(ctx.from?.id) !== ownerUserId()) { await ctx.reply('Owner only.'); return; }
    const reference = ctx.match.trim();
    if (!reference) { await ctx.reply('Use /users, then /revoke REF.'); return; }
    const user = resolveUserReference(reference);
    if (!user) { await ctx.reply('Reference is missing or ambiguous. Open /users and use a prefix from that page.'); return; }
    if (user.isOwner) { await ctx.reply('The owner cannot be revoked.'); return; }
    setUserStatus(user.userId, 'revoked');
    pendingCvUpload.delete(user.userId); pendingRefreshHashes.delete(user.userId); pendingWindowSetup.delete(user.userId);
    await ctx.reply(`Revoked access for ${user.userId}.`);
    await getBot().api.sendMessage(user.chatId, 'Your bot access was revoked. You may submit a new /request later.');
  });
  instance.command('usage', async (ctx) => {
    if (String(ctx.from?.id) !== ownerUserId()) { await ctx.reply('Owner only.'); return; }
    const rows = userUsageSummaries();
    const lines = rows.map((row) => `${row.userId.padEnd(14)} ${String(row.scores24h).padStart(4)}/${String(row.scoresTotal).padEnd(5)} ` +
      `${String(row.applications24h).padStart(3)}/${String(row.applicationsTotal).padEnd(4)} ${row.displayName.slice(0, 18)}`);
    await ctx.reply(`<b>Usage — rolling 24h / total</b>\n<pre>${escapeHtml(['User ID         Scores      Apps     User', ...lines].join('\n'))}</pre>`,
      { parse_mode: 'HTML' });
  });
  instance.command('search', async (ctx) => {
    const query = ctx.match.trim();
    if (!query) { await ctx.reply('Usage: /search words from a vacancy title, employer, description, or skills'); return; }
    const results = searchScoredVacancies(String(ctx.from!.id), query);
    if (!results.length) { await ctx.reply('No matching scored vacancies.'); return; }
    const text = results.map((vacancy) => `<b>${vacancy.score}/100 — ${escapeHtml(vacancy.name)}</b>\n` +
      `${escapeHtml(vacancy.employer)} · <code>${vacancy.applyId}</code> · <a href="${escapeHtml(vacancy.url)}">open</a>`).join('\n\n');
    await ctx.reply(text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  });
  instance.command('export_me', async (ctx) => {
    const userId = String(ctx.from!.id);
    const bytes = Buffer.from(`${JSON.stringify(exportUserData(userId), null, 2)}\n`);
    await ctx.replyWithDocument(new InputFile(bytes, `jobseeker-export-${new Date().toISOString().slice(0, 10)}.json`));
  });
  instance.command('delete_me', async (ctx) => deletePersonalData(ctx, ctx.match));
  instance.hears(/^\/delete-me(?:@\w+)?(?:\s+(.*))?$/i, async (ctx) => deletePersonalData(ctx, ctx.match[1] ?? ''));
  instance.command('window', async (ctx) => {
    const userId = String(ctx.from!.id); const action = ctx.match.trim().toLowerCase();
    if (action === 'status') { await ctx.reply(`Delivery: ${deliverySettingsStatus(userId)}`); return; }
    if (action === 'cancel') {
      pendingWindowSetup.delete(userId); await ctx.reply('Notification setup cancelled.'); return;
    }
    if (action) { await ctx.reply('Use /window to start, /window status to review, or /window cancel.'); return; }
    pendingWindowSetup.set(userId, { step: 'start' });
    await ctx.reply(`Current delivery: ${deliverySettingsStatus(userId)}\n\n1/4 When should notifications start? Send HH:MM, for example 09:00.`);
  });
  instance.on('message:text', async (ctx, next) => {
    const userId = String(ctx.from.id); const setup = pendingWindowSetup.get(userId);
    if (!setup) { await next(); return; }
    const value = ctx.message.text.trim();
    try {
      if (setup.step === 'start') {
        parseClockMinutes(value); pendingWindowSetup.set(userId, { step: 'end', start: value });
        await ctx.reply('2/4 When should notifications end? Send HH:MM, for example 22:00.');
      } else if (setup.step === 'end') {
        parseClockMinutes(value);
        if (parseClockMinutes(setup.start!) === parseClockMinutes(value)) throw new Error('Notification start and end must differ.');
        pendingWindowSetup.set(userId, { ...setup, step: 'digest', end: value });
        await ctx.reply('3/4 When should the daily digest be sent? Send HH:MM, for example 09:30.');
      } else if (setup.step === 'digest') {
        parseClockMinutes(value); pendingWindowSetup.set(userId, { ...setup, step: 'timezone', digest: value });
        await ctx.reply('4/4 What is your UTC offset? Send +3, -5, or +3:30.');
      } else {
        const timezone = normalizeUtcOffset(value);
        updateDeliverySettings(userId, setup.start!, setup.end!, setup.digest!, timezone);
        pendingWindowSetup.delete(userId);
        await ctx.reply(`Saved. Delivery: ${deliverySettingsStatus(userId)}`);
      }
    } catch (error) { await ctx.reply(error instanceof Error ? error.message : String(error)); }
  });
  instance.command('privacy', async (ctx) => {
    await ctx.reply('Privacy: normalized CV text, canonical blocks, source metadata and hashes, derived profiles/embeddings, numeric scores, usage, and delivery/application state are stored in private SQLite storage. High-score alert explanations are retained only until delivery. Completed model conversation history, source uploads, generated PDFs, and cover letters are not retained. Relevant CV and vacancy content is sent to the configured third-party model provider for profile generation, scoring, and tailoring. Data remains while access is active until /delete_me confirm; encrypted backups may retain deleted data only for the documented backup-retention period. Use /export_me before deletion. Uploading with /cv confirms you understand this processing.');
  });
  instance.command('cv', async (ctx) => {
    const userId = String(ctx.from!.id);
    if (ctx.match.trim()) { await ctx.reply('Usage: /cv'); return; }
    if (!pendingCvUpload.has(userId)) {
      const cooldownMs = config.cvUploadSessionCooldownMinutes * 60_000;
      const remaining = (lastCvSessions.get(userId) ?? 0) + cooldownMs - Date.now();
      if (remaining > 0) {
        await ctx.reply(`Please wait ${Math.max(1, Math.ceil(remaining / 60_000))} minute(s) before starting another CV upload session.`);
        return;
      }
      lastCvSessions.set(userId, Date.now());
    }
    pendingCvUpload.add(userId);
    await ctx.reply(`${cvStatus(userId)}\n\nBy uploading, you confirm the /privacy processing notice. ` +
      'Send one authoritative CV in any language as PDF, Markdown, TXT, or DOCX (maximum 20 MB). ' +
      'It will replace the current source; tailored documents are translated to each vacancy language.');
  });
  instance.on('message:document', async (ctx) => {
    const userId = String(ctx.from.id);
    if (!pendingCvUpload.has(userId)) { await ctx.reply('Use /cv first, then send the CV document.'); return; }
    if (activeCvImports.has(userId)) { await ctx.reply('Your previous CV document is still being checked.'); return; }
    activeCvImports.add(userId);
    try {
      const document = ctx.message.document;
      const filename = document.file_name ?? 'cv';
      if (document.file_size != null && document.file_size > maximumCvBytes) {
        await ctx.reply('CV document exceeds the 20 MB limit.'); return;
      }
      const supportedExtension = /\.(?:pdf|md|markdown|txt|docx)$/i.test(filename);
      const unsupportedExtension = /\.[a-z0-9]{1,10}$/i.test(filename) && !supportedExtension;
      const supportedMediaType = ['application/pdf', 'text/markdown', 'text/plain',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(document.mime_type ?? '');
      if (unsupportedExtension || (!supportedExtension && !supportedMediaType)) {
        await ctx.reply('Please send a PDF, Markdown, TXT, or DOCX document.'); return;
      }
      const bytes = await downloadTelegramFile(document.file_id, document.file_size);
      await importCvSource(userId, filename, document.mime_type, bytes);
      pendingCvUpload.delete(userId);
      await ctx.reply(`CV source replaced. ${cvStatus(userId)}\nRefreshing searches…`);
      refreshSearchesAfterCvUpload(userId);
    } catch (error) {
      console.error(`CV import failed for user ${userId}: ${errorMessage(error)}`);
      if (isApprovedUser(userId)) await ctx.reply('The CV could not be safely processed. Check the format and size, then retry.');
    } finally { activeCvImports.delete(userId); }
  });
  instance.hears(/^\s*([a-zA-Z]{1,6})\s*$/, async (ctx) => {
    if (!ctx.from) return;
    const userId = String(ctx.from.id); const reference = ctx.match[1].toLowerCase();
    const matches = reference.length === 6 ? [getScoredVacancyByApplyId(userId, reference)].filter((vacancy) => vacancy !== null)
      : latestDigestVacanciesByApplyIdPrefix(userId, reference);
    if (!matches.length) { await ctx.reply(`No vacancy in your latest digest matches Apply ID ${reference}.`); return; }
    if (matches.length > 1) { await ctx.reply(`Apply ID prefix ${reference} is ambiguous. Send more letters.`); return; }
    const vacancy = matches[0]; const key = `${userId}:${vacancy.id}`;
    if (applicationJobs.has(key)) { await ctx.reply(`Application documents for ${vacancy.applyId} are already being prepared.`); return; }
    void generateAndSendApplication(userId, vacancy.id);
  });
  instance.callbackQuery(/^skip:(\d+)$/, async (ctx) => {
    const userId = String(ctx.from.id); const id = Number(ctx.match[1]); skipVacancy(userId, id);
    await ctx.answerCallbackQuery({ text: 'Skipped' }); await ctx.deleteMessage();
  });
  instance.callbackQuery(/^apply:(\d+)$/, async (ctx) => {
    const userId = String(ctx.from.id); const id = Number(ctx.match[1]);
    await ctx.answerCallbackQuery({ text: 'Preparing CV and cover letter…' });
    const vacancy = getScoredVacancy(userId, id);
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard()
      .url(`Open ${sourceLabel(vacancy?.source ?? '')}`, vacancy?.url ?? 'https://hh.ru') });
    void generateAndSendApplication(userId, id);
  });
  instance.catch((error) => console.error(`Telegram bot error: ${errorMessage(error.error)}`));
  void instance.start({ allowed_updates: ['message', 'callback_query'], onStart: async () => {
    await instance.api.deleteMyCommands();
    await instance.api.setMyCommands([
      { command: 'start', description: 'Show access and setup instructions' },
      { command: 'request', description: 'Request owner approval' },
      { command: 'cv', description: 'Upload or replace your CV source' },
      { command: 'privacy', description: 'Review CV data processing and retention' },
      { command: 'window', description: 'Set notification window and digest time' },
      { command: 'search', description: 'Search your scored vacancies' },
      { command: 'export_me', description: 'Export your personal data' },
      { command: 'delete_me', description: 'Delete your personal data' },
    ]);
    console.info('Telegram bot started; multi-user commands registered');
  } });
}

export async function stopTelegramBot(): Promise<void> {
  if (bot?.isRunning()) await bot.stop();
}
