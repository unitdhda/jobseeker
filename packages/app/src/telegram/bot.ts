import { Bot, InlineKeyboard, InputFile } from 'grammy';
import { type InputRichBlockTable, type InputRichMessage } from 'grammy/types';
import { config } from '../config.ts';
import {
  deleteUserData,
  exportUserData,
  getCvSource,
  getDeliverySettings,
  getScoredVacancy,
  getScoredVacancyByApplyId,
  getTelegramUser,
  isApprovedUser,
  scoredVacanciesByApplyIdPrefix,
  listTelegramUsers,
  requestAccess,
  searchScoredVacancies,
  setUserLocale,
  setUserStatus,
  skipVacancy,
  touchTelegramUser,
  userUsageSummaries,
  llmUsageSummary, scraperSummary,
  type ScoredVacancy,
  type TelegramUser,
  addressableDigestPage,
} from '../postgres.ts';
import { importCvSource } from '../cv.ts';
import { type ApplicationArtifact } from '../postgres.ts';
import { maximumCvBytes } from '../cv.ts';
import { errorMessage } from '../observability.ts';
import {
  claimTelegramSession, deleteTelegramSession, getTelegramSession, setTelegramSession,
} from '../postgres.ts';
import {
  deliverySettingsStatus,
  normalizeUtcOffset,
  parseClockMinutes,
  removeDeliveryWindow,
  updateDeliveryTimezone,
  updateDeliveryWindow,
  updateDigestTime,
} from '../vacancies/jobs.ts';
import {
  currentBot, getBot, identity, isBotConfigured, isUnchangedMessageError, markBotConfigured, ownerUserId, targetChat,
  type BotContext,
} from './api.ts';
import {
  applicationKeyboard,
  artifactLabels,
  cell,
  compactNumber,
  chunkMessageLines,
  deploymentStatusText,
  escapeHtml,
  headerCell,
  money,
  scraperTimelineChart, scraperStatusMessage,
  usageTimelineChart,
  userStatusText,
  digestPageMessage, digestPageSize,
} from './format.ts';
import { sendDailyDigest } from './delivery.ts';
import { startEditableIndicator, type EditableIndicator } from './indicators.ts';
import {
  cvRetryKeyboard,
  cvStatus,
  downloadTelegramFile,
  finishNotice,
  refreshSearchesAfterCvUpload,
  runApplication,
} from './actions.ts';
import {
  activeUserWorkflow,
  claimUserWorkflow,
  userWorkflowBusyMessage,
  type UserWorkflowKind,
  type UserWorkflowLease,
} from './workflow-lock.ts';
import { defaultLocale, locales, messages, normalizeLocale, userLocale, type Locale } from '../i18n/index.ts';


const latestUserPages = new Map<string, string[]>();
type WindowSetup = { step: 'start' | 'end' | 'digest' | 'timezone'; start?: string };
const usersPageSize = 8;
const cvUploadSessionTtlMs = 30 * 60_000;
const windowSetupTtlMs = 30 * 60_000;

function windowKeyboard(locale:Locale):InlineKeyboard{const text=messages(locale).delivery;return new InlineKeyboard()
  .text(text.windowButton,'window:time').row()
  .text(text.timezoneButton,'window:timezone').row()
  .text(text.digestButton,'window:digest').row()
  .text(text.removeButton,'window:remove');}
async function showWindowSettings(ctx:BotContext,userId:string):Promise<void>{
  await ctx.reply(ctx.t.delivery.settings(await deliverySettingsStatus(userId,ctx.locale)),
    {reply_markup:windowKeyboard(ctx.locale)});
}
function userPrefix(userId: string, pageIds: string[]): string {
  let length = 1;
  while (length < userId.length && pageIds.some((other) => other !== userId && other.startsWith(userId.slice(0, length)))) length++;
  return userId.slice(0, length);
}
async function usersPage(pageInput: number, locale: Locale): Promise<{ richMessage: InputRichMessage; keyboard: InlineKeyboard; ids: string[]; page: number }> {
  const text = messages(locale);
  const total = (await listTelegramUsers(1, 0)).total; const pages = Math.max(1, Math.ceil(total / usersPageSize));
  const page = Math.max(0, Math.min(pageInput, pages - 1)); const { users } = await listTelegramUsers(usersPageSize, page * usersPageSize);
  const ids = users.map((user) => user.userId);
  // Per-user counts live next to the person they describe rather than in /usage, which now reports model spend only.
  const activity = new Map((await userUsageSummaries()).map((row) => [row.userId, row]));
  const userRows = await Promise.all(users.map(async (user) => {
    const ref = user.isOwner ? '—' : userPrefix(user.userId, ids);
    const name = (user.username ? `@${user.username}` : user.displayName).replace(/\s+/g, ' ').slice(0, 24);
    const counts = activity.get(user.userId);
    return [cell(ref), cell(`${name}\n${user.userId}`), cell(userStatusText(user.status, locale)),
      cell(await getCvSource(user.userId) ? text.common.yes : text.common.no, 'center'),
      cell(`${counts?.scores24h ?? 0}/${counts?.scoresTotal ?? 0}\n${counts?.applications24h ?? 0}/${counts?.applicationsTotal ?? 0}`, 'right'),
      cell(await deliverySettingsStatus(user.userId, locale))];
  }));
  const table: InputRichBlockTable = {
    type: 'table', is_bordered: true, is_striped: true,
    cells: [[headerCell(text.owner.users.reference, 'left'), headerCell(text.owner.users.person, 'left'),
      headerCell(text.owner.users.status, 'left'), headerCell(text.owner.users.cv, 'center'),
      headerCell(text.owner.users.activity, 'right'), headerCell(text.owner.users.delivery, 'left')], ...userRows],
  };
  const richMessage: InputRichMessage = { blocks: [
    { type: 'heading', size: 3, text: text.owner.users.title(page + 1, pages) },
    table,
    { type: 'paragraph', text: text.owner.users.legend },
    { type: 'paragraph', text: text.owner.users.actions },
  ] };
  const keyboard = new InlineKeyboard();
  if (page > 0) keyboard.text(text.common.previousPage, `users-page:${page - 1}`);
  if (page + 1 < pages) keyboard.text(text.common.nextPage, `users-page:${page + 1}`);
  return { richMessage, keyboard, ids, page };
}
/**
 * Repeatable owner commands replace their own previous output instead of stacking: the old command message and its
 * answer are removed before the new answer is sent. Telegram refuses to delete messages older than about 48 hours,
 * so the record is kept only that long and failures are ignored.
 */
const transientMessageTtlMs = 47 * 60 * 60 * 1_000;
async function dropTrackedMessages(userId: string, kind: string): Promise<void> {
  const stored = await getTelegramSession<{ ids: number[] }>(userId, kind);
  if (!stored?.ids?.length) return;
  const chat = await targetChat(userId);
  for (const id of stored.ids) await getBot().api.deleteMessage(chat, id).catch(() => undefined);
  await deleteTelegramSession(userId, kind).catch(() => undefined);
}
async function trackMessages(userId: string, kind: string, ids: (number | undefined)[]): Promise<void> {
  const present = ids.filter((id): id is number => typeof id === 'number');
  if (present.length) await setTelegramSession(userId, kind, { ids: present }, transientMessageTtlMs);
}

async function showUsers(ctx: BotContext, page: number, edit = false): Promise<number | undefined> {
  const view = await usersPage(page, ctx.locale); latestUserPages.set(ownerUserId(), view.ids);
  const options = { reply_markup: view.keyboard };
  // Paging edits the existing message, so its id stays valid and stays tracked.
  if (edit) { await ctx.editMessageText(view.richMessage, options); return undefined; }
  return (await ctx.replyWithRichMessage(view.richMessage, options)).message_id;
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
async function deletePersonalData(ctx: BotContext, confirmation: string): Promise<void> {
  if (!ctx.from) return;
  const userId = String(ctx.from.id);
  if (confirmation.trim().toLowerCase() !== 'confirm') {
    await ctx.reply(ctx.t.personalData.confirmPrompt);
    return;
  }
  if (await activeUserWorkflow(userId)) {
    await ctx.reply(ctx.t.personalData.busy); return;
  }
  await Promise.all(['cv-upload', 'cv-cooldown', 'window-setup'].map((kind) => deleteTelegramSession(userId, kind)));
  await deleteUserData(userId);
  await ctx.reply(ctx.t.personalData.deleted);
}

async function approvedStartText(user: TelegramUser, locale: Locale): Promise<string> {
  const text = messages(locale);
  const ownerCommands = user.isOwner ? text.start.ownerCommands : '';
  return text.start.approved(await cvStatus(user.userId, locale),
    await deliverySettingsStatus(user.userId, locale)) + ownerCommands;
}

/** The picker names each language in itself, and marks the one in use. */
function languageKeyboard(current: Locale): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const locale of locales) {
    keyboard.text(`${locale === current ? '• ' : ''}${messages(locale).name}`, `language:${locale}`);
  }
  return keyboard;
}
function commandDescriptions(locale: Locale): { command: string; description: string }[] {
  const text = messages(locale).commands;
  return [
    { command: 'start', description: text.start },
    { command: 'request', description: text.request },
    { command: 'cv', description: text.cv },
    { command: 'privacy', description: text.privacy },
    { command: 'window', description: text.window },
    { command: 'digest', description: text.digest },
    { command: 'search', description: text.search },
    { command: 'language', description: text.language },
    { command: 'export_me', description: text.export_me },
    { command: 'delete_me', description: text.delete_me },
  ];
}
/**
 * Telegram scopes command menus by the client's own language, which says nothing about the language a person
 * picked here. A chat-scoped menu is the only one that follows the choice, so it is set when the choice is made.
 */
async function applyChatCommands(chatId: string, locale: Locale): Promise<void> {
  await getBot().api.setMyCommands(commandDescriptions(locale),
    { scope: { type: 'chat', chat_id: Number(chatId) } })
    .catch((error) => console.warn(`Could not set chat command menu: ${errorMessage(error)}`));
}

function configureTelegramBot(): Bot<BotContext> | null {
  if (!process.env.TELEGRAM_BOT_TOKEN) return null;
  const instance = getBot();
  if (isBotConfigured()) return instance;
  const ownerId = ownerUserId();
  if (config.telegramChatId && config.telegramChatId !== ownerId) {
    throw new Error('TELEGRAM_CHAT_ID must be the owner private-chat ID and match TELEGRAM_USER_ID.');
  }
  instance.use(async (ctx, next) => {
    const currentIdentity = identity(ctx);
    if (!currentIdentity) return;
    const user = await touchTelegramUser(currentIdentity);
    // Resolved once per update from the row just written, so every handler below speaks one settled language.
    ctx.locale = normalizeLocale(user.locale) ?? defaultLocale;
    ctx.t = messages(ctx.locale);
    const command = ctx.message?.text?.match(/^\/(\w+)/)?.[1]?.toLowerCase();
    // Choosing a language is not a privilege: someone still waiting for access should be able to read the bot,
    // by command or by the picker's own buttons.
    const alwaysAllowed = command === 'start' || command === 'request' || command === 'language'
      || Boolean(ctx.callbackQuery?.data?.startsWith('language:'));
    if (user.status === 'approved' || user.isOwner || alwaysAllowed) await next();
    else await ctx.reply(ctx.t.access.denied(userStatusText(user.status, ctx.locale)));
  });
  instance.command('start', async (ctx) => {
    const currentIdentity = identity(ctx); if (!currentIdentity) return;
    const user = await getTelegramUser(currentIdentity.userId);
    if (!user) throw new Error('Telegram user was not persisted.');
    if (user.status === 'approved') await ctx.reply(await approvedStartText(user, ctx.locale));
    else await ctx.reply(ctx.t.access.privateBot(userStatusText(user.status, ctx.locale)));
  });
  instance.command('language', async (ctx) => {
    await ctx.reply(ctx.t.language.prompt(ctx.t.name), { reply_markup: languageKeyboard(ctx.locale) });
  });
  instance.callbackQuery(/^language:([a-z-]+)$/, async (ctx) => {
    const requested = normalizeLocale(ctx.match[1]);
    if (!requested) { await ctx.answerCallbackQuery(); return; }
    if (requested === ctx.locale) { await ctx.answerCallbackQuery({ text: ctx.t.language.unchangedToast }); return; }
    const userId = String(ctx.from.id);
    await setUserLocale(userId, requested);
    const text = messages(requested);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(text.language.changed(text.name), { reply_markup: languageKeyboard(requested) })
      .catch((error) => { if (!isUnchangedMessageError(error)) throw error; });
    await applyChatCommands(String(ctx.chat?.id ?? userId), requested);
  });
  instance.command('request', async (ctx) => {
    const currentIdentity = identity(ctx); if (!currentIdentity) return;
    const request = await requestAccess(currentIdentity); const { user } = request;
    if (user.isOwner || user.status === 'approved') { await ctx.reply(ctx.t.access.alreadyGranted); return; }
    if (request.retryAfterSeconds > 0) {
      const minutes = Math.max(1, Math.ceil(request.retryAfterSeconds / 60));
      await ctx.reply(ctx.t.access.retryAfterMinutes(minutes)); return;
    }
    if (!request.notifyOwner) { await ctx.reply(ctx.t.access.alreadyPending); return; }
    // The request card is read by the owner, so it is written in the owner's language, not the applicant's.
    const owner = messages(await userLocale(ownerUserId()));
    const keyboard = new InlineKeyboard().text(owner.access.approveButton, `access:approve:${user.userId}`)
      .text(owner.access.rejectButton, `access:reject:${user.userId}`);
    const nameHtml = `${escapeHtml(user.displayName)}${user.username ? ` (@${escapeHtml(user.username)})` : ''}`;
    await getBot().api.sendMessage(await targetChat(ownerUserId()),
      owner.access.requestCard(nameHtml, user.userId), { parse_mode: 'HTML', reply_markup: keyboard });
    await ctx.reply(ctx.t.access.requestSent);
  });
  instance.callbackQuery(/^access:(approve|reject):(\d+)$/, async (ctx) => {
    if (String(ctx.from.id) !== ownerUserId()) { await ctx.answerCallbackQuery({ text: ctx.t.common.ownerOnlyToast }); return; }
    const action = ctx.match[1]; const userId = ctx.match[2];
    const current = await getTelegramUser(userId);
    if (!current) { await ctx.answerCallbackQuery({ text: ctx.t.access.userNotFoundToast }); return; }
    if (current.status !== 'pending') {
      await ctx.answerCallbackQuery({ text: ctx.t.access.alreadyHandledToast(userStatusText(current.status, ctx.locale)) });
      await ctx.deleteMessage().catch(() => undefined);
      return;
    }
    const user = await setUserStatus(userId, action === 'approve' ? 'approved' : 'rejected');
    if (!user) throw new Error('Telegram user disappeared during access update.');
    await ctx.answerCallbackQuery({ text: action === 'approve' ? ctx.t.access.approvedToast : ctx.t.access.rejectedToast });
    // The decision is confirmed by the callback toast, so the spent request card is removed rather than left behind.
    await ctx.deleteMessage().catch(() => undefined);
    const applicant = messages(await userLocale(userId));
    await getBot().api.sendMessage(user.chatId, action === 'approve'
      ? applicant.access.approvedNotice : applicant.access.rejectedNotice);
  });
  instance.command('ok', async (ctx) => {
    if (String(ctx.from?.id) !== ownerUserId()) { await ctx.reply(ctx.t.common.ownerOnly); return; }
    const reference = ctx.match.trim();
    if (!reference) { await ctx.reply(ctx.t.owner.approve.usage); return; }
    const user = await resolveApprovalReference(reference);
    if (!user) { await ctx.reply(ctx.t.owner.approve.notFound); return; }
    if (user.isOwner || user.status === 'approved') { await ctx.reply(ctx.t.owner.approve.alreadyApproved); return; }
    await setUserStatus(user.userId, 'approved');
    await ctx.reply(ctx.t.owner.approve.done(user.username ? `@${user.username}` : user.userId));
    try {
      const applicant = messages(await userLocale(user.userId));
      await getBot().api.sendMessage(user.chatId, applicant.access.approvedNotice);
    } catch (error) {
      console.error(`Could not notify approved user ${user.userId}: ${errorMessage(error)}`);
      await ctx.reply(ctx.t.owner.approve.notifyFailed);
    }
  });
  instance.command('users', async (ctx) => {
    if (String(ctx.from?.id) !== ownerUserId()) { await ctx.reply(ctx.t.common.ownerOnly); return; }
    await dropTrackedMessages(ownerUserId(), 'users-messages');
    const page = Math.max(0, Number.parseInt(ctx.match.trim(), 10) - 1 || 0);
    const sent = await showUsers(ctx, page);
    await trackMessages(ownerUserId(), 'users-messages', [ctx.message?.message_id, sent]);
  });
  instance.callbackQuery(/^users-page:(\d+)$/, async (ctx) => {
    if (String(ctx.from.id) !== ownerUserId()) { await ctx.answerCallbackQuery({ text: ctx.t.common.ownerOnlyToast }); return; }
    await ctx.answerCallbackQuery(); await showUsers(ctx, Number(ctx.match[1]), true);
  });
  instance.command('revoke', async (ctx) => {
    if (String(ctx.from?.id) !== ownerUserId()) { await ctx.reply(ctx.t.common.ownerOnly); return; }
    const reference = ctx.match.trim();
    if (!reference) { await ctx.reply(ctx.t.owner.revoke.usage); return; }
    const user = await resolveUserReference(reference);
    if (!user) { await ctx.reply(ctx.t.owner.revoke.ambiguous); return; }
    if (user.isOwner) { await ctx.reply(ctx.t.owner.revoke.refusedOwner); return; }
    await setUserStatus(user.userId, 'revoked');
    await Promise.all(['cv-upload', 'window-setup'].map((kind) => deleteTelegramSession(user.userId, kind)));
    await ctx.reply(ctx.t.owner.revoke.done(user.userId));
    await getBot().api.sendMessage(user.chatId, messages(await userLocale(user.userId)).access.revokedNotice);
  });
  instance.command('usage', async (ctx) => {
    if (String(ctx.from?.id) !== ownerUserId()) { await ctx.reply(ctx.t.common.ownerOnly); return; }
    const [llm,settings]=await Promise.all([llmUsageSummary(),getDeliverySettings(ownerUserId())]);
    const chart=usageTimelineChart(llm.hourlyTimeline,settings?.timezone??config.timezone,ctx.locale);
    await dropTrackedMessages(ownerUserId(), 'usage-messages');
    const usage=ctx.t.owner.usage;
    const sent = await ctx.reply(`${usage.title}\n`+
      `${usage.turns(llm.turns24h,llm.turnsTotal)}\n`+
      `${usage.tokens(compactNumber(llm.tokens24h,ctx.locale),compactNumber(llm.tokensTotal,ctx.locale))}\n`+
      `${usage.cost(money(llm.cost24hUsd),money(llm.costTotalUsd))}\n\n`+
      `${ctx.t.owner.hourlyTitle}\n<pre>${escapeHtml(chart)}</pre>`,
      { parse_mode: 'HTML' });
    await trackMessages(ownerUserId(), 'usage-messages', [ctx.message?.message_id, sent.message_id]);
  });
  instance.command('scraper', async (ctx) => {
    if (String(ctx.from?.id) !== ownerUserId()) { await ctx.reply(ctx.t.common.ownerOnly); return; }
    const [summary,settings]=await Promise.all([scraperSummary(),getDeliverySettings(ownerUserId())]);
    const chart=scraperTimelineChart(summary.hourly,settings?.timezone??config.timezone,ctx.locale);
    await dropTrackedMessages(ownerUserId(), 'scraper-messages');
    // Twenty sources no longer fit one Telegram message; the chart keeps its own message so <pre> never splits.
    const ids: (number | undefined)[] = [ctx.message?.message_id];
    for (const chunk of chunkMessageLines(scraperStatusMessage(summary,ctx.locale))) {
      ids.push((await ctx.reply(chunk, { parse_mode: 'HTML' })).message_id);
    }
    ids.push((await ctx.reply(
      `${ctx.t.owner.hourlyTitle}\n<pre>${escapeHtml(chart)}</pre>`,
      { parse_mode: 'HTML' })).message_id);
    await trackMessages(ownerUserId(), 'scraper-messages', ids);
  });
  instance.command('status', async (ctx) => {
    if (String(ctx.from?.id) !== ownerUserId()) { await ctx.reply(ctx.t.common.ownerOnly); return; }
    await dropTrackedMessages(ownerUserId(), 'status-messages');
    const sent = await ctx.reply(`${ctx.t.owner.deploymentTitle}\n<pre>${escapeHtml(deploymentStatusText(ctx.locale))}</pre>`,
      { parse_mode: 'HTML' });
    await trackMessages(ownerUserId(), 'status-messages', [ctx.message?.message_id, sent.message_id]);
  });
  instance.command('search', async (ctx) => {
    const query = ctx.match.trim();
    if (!query) { await ctx.reply(ctx.t.search.usage); return; }
    const results = await searchScoredVacancies(String(ctx.from!.id), query);
    if (!results.length) { await ctx.reply(ctx.t.search.empty); return; }
    const text = results.map((vacancy) => ctx.t.search.result(vacancy.score, escapeHtml(vacancy.name),
      escapeHtml(vacancy.employer), vacancy.applyId, escapeHtml(vacancy.url), ctx.t.common.open)).join('\n\n');
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
    const userId=String(ctx.from!.id);await deleteTelegramSession(userId,'window-setup');await showWindowSettings(ctx,userId);
  });
  instance.callbackQuery(/^window:(time|timezone|digest|remove)$/,async(ctx)=>{
    const userId=String(ctx.from.id),action=ctx.match[1];await ctx.answerCallbackQuery();
    await deleteTelegramSession(userId,'window-setup');
    if(action==='remove'){
      await removeDeliveryWindow(userId);
      await ctx.reply(ctx.t.delivery.windowRemoved(await deliverySettingsStatus(userId,ctx.locale)),
        {reply_markup:windowKeyboard(ctx.locale)});return;
    }
    if(action==='time'){
      await setTelegramSession(userId,'window-setup',{step:'start'} satisfies WindowSetup,windowSetupTtlMs);
      await ctx.reply(ctx.t.delivery.askStart);return;
    }
    if(action==='timezone'){
      await setTelegramSession(userId,'window-setup',{step:'timezone'} satisfies WindowSetup,windowSetupTtlMs);
      await ctx.reply(ctx.t.delivery.askTimezone);return;
    }
    await setTelegramSession(userId,'window-setup',{step:'digest'} satisfies WindowSetup,windowSetupTtlMs);
    await ctx.reply(ctx.t.delivery.askDigest);
  });
  instance.command('digest',async(ctx)=>{
    await sendDailyDigest(String(ctx.from!.id),{sendEmptyTable:true});
  });
  instance.on('message:text', async (ctx, next) => {
    const userId = String(ctx.from.id); const setup = await getTelegramSession<WindowSetup>(userId, 'window-setup');
    if (!setup) { await next(); return; }
    const value = ctx.message.text.trim();
    try {
      if (setup.step === 'start') {
        parseClockMinutes(value, ctx.locale);
        await setTelegramSession(userId, 'window-setup', { step: 'end', start: value } satisfies WindowSetup, windowSetupTtlMs);
        await ctx.reply(ctx.t.delivery.askEnd);
      } else if (setup.step === 'end') {
        await updateDeliveryWindow(userId,setup.start!,value,ctx.locale);await deleteTelegramSession(userId,'window-setup');
        await ctx.reply(ctx.t.delivery.windowSaved(await deliverySettingsStatus(userId,ctx.locale)),
          {reply_markup:windowKeyboard(ctx.locale)});
      } else if (setup.step === 'digest') {
        await updateDigestTime(userId,value,ctx.locale);await deleteTelegramSession(userId,'window-setup');
        await ctx.reply(ctx.t.delivery.digestSaved(await deliverySettingsStatus(userId,ctx.locale)),
          {reply_markup:windowKeyboard(ctx.locale)});
      } else {
        await updateDeliveryTimezone(userId,normalizeUtcOffset(value,ctx.locale),ctx.locale);
        await deleteTelegramSession(userId,'window-setup');
        await ctx.reply(ctx.t.delivery.timezoneSaved(await deliverySettingsStatus(userId,ctx.locale)),
          {reply_markup:windowKeyboard(ctx.locale)});
      }
    } catch (error) { await ctx.reply(error instanceof Error ? error.message : String(error)); }
  });
  instance.command('privacy', async (ctx) => {
    await ctx.reply(ctx.t.personalData.privacy);
  });
  instance.command('cv', async (ctx) => {
    const userId = String(ctx.from!.id);
    if (ctx.match.trim()) { await ctx.reply(ctx.t.cv.noArguments); return; }
    const active = await activeUserWorkflow(userId);
    if (active) { await ctx.reply(userWorkflowBusyMessage(active, 'cv-import', ctx.locale)); return; }
    if (!await getTelegramSession(userId, 'cv-upload')) {
      const cooldownMs = config.cvUploadSessionCooldownMinutes * 60_000;
      const cooldown = await claimTelegramSession(userId, 'cv-cooldown', {}, cooldownMs);
      if (!cooldown.claimed) {
        const remaining = cooldown.expiresAt.getTime() - Date.now();
        await ctx.reply(ctx.t.cv.cooldownMinutes(Math.max(1, Math.ceil(remaining / 60_000))));
        return;
      }
    }
    await setTelegramSession(userId, 'cv-upload', {}, cvUploadSessionTtlMs);
    await ctx.reply(ctx.t.cv.prompt(await cvStatus(userId, ctx.locale)));
  });
  instance.on('message:document', async (ctx) => {
    const userId = String(ctx.from.id);
    if (!await getTelegramSession(userId, 'cv-upload')) { await ctx.reply(ctx.t.cv.uploadFirst); return; }
    const document = ctx.message.document;
    const filename = document.file_name ?? 'cv';
    let indicator: EditableIndicator | null = null;
    let lease: UserWorkflowLease | null = null;
    let leaseHandedOver = false;
    try {
      if (document.file_size != null && document.file_size > maximumCvBytes) {
        await ctx.reply(ctx.t.cv.tooLarge); return;
      }
      const supportedExtension = /\.(?:pdf|md|markdown|txt|docx)$/i.test(filename);
      const unsupportedExtension = /\.[a-z0-9]{1,10}$/i.test(filename) && !supportedExtension;
      const supportedMediaType = ['application/pdf', 'text/markdown', 'text/plain',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(document.mime_type ?? '');
      if (unsupportedExtension || (!supportedExtension && !supportedMediaType)) {
        await ctx.reply(ctx.t.cv.unsupportedFormat); return;
      }
      const claim = await claimUserWorkflow(userId, 'cv-import');
      if (!claim.claimed) { await ctx.reply(userWorkflowBusyMessage(claim.active, 'cv-import', ctx.locale)); return; }
      lease = claim.lease;
      indicator = await startEditableIndicator(userId, ctx.t.cv.downloading);
      const bytes = await downloadTelegramFile(document.file_id, document.file_size);
      indicator?.setLabel(ctx.t.cv.parsing);
      await importCvSource(userId, filename, document.mime_type, bytes);
      await deleteTelegramSession(userId, 'cv-upload');
      indicator?.setLabel(ctx.t.cv.saved);
      await lease.setKind('profile-refresh');
      const handedOver = indicator; indicator = null;
      await refreshSearchesAfterCvUpload(userId, handedOver, lease, ctx.locale);
      leaseHandedOver = true;
    } catch (error) {
      console.error(`CV import failed for user ${userId}: ${errorMessage(error)}`);
      if (await isApprovedUser(userId)) {
        await finishNotice(userId, indicator, ctx.t.cv.importFailed, cvRetryKeyboard('cv:retry', ctx.locale));
      } else await indicator?.stop().catch((stopError) => console.warn(`Could not stop CV indicator: ${errorMessage(stopError)}`));
    } finally {
      if (lease && !leaseHandedOver) await lease.release().catch((error) =>
        console.warn(`Could not release CV workflow: ${errorMessage(error)}`));
    }
  });
  instance.callbackQuery('cv:retry', async (ctx) => {
    const userId = String(ctx.from.id);
    const active = await activeUserWorkflow(userId);
    if (active) {
      await ctx.answerCallbackQuery({ text: ctx.t.application.busyToast });
      await ctx.reply(userWorkflowBusyMessage(active, 'cv-import', ctx.locale)); return;
    }
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup().catch(() => undefined);
    // The upload cooldown was already claimed for this attempt, so a retry only re-arms the upload session.
    await setTelegramSession(userId, 'cv-upload', {}, cvUploadSessionTtlMs);
    await ctx.reply(ctx.t.cv.retryUpload);
  });
  instance.callbackQuery('cv:refresh', async (ctx) => {
    const userId = String(ctx.from.id);
    const claim = await claimUserWorkflow(userId, 'profile-refresh');
    if (!claim.claimed) {
      await ctx.answerCallbackQuery({ text: ctx.t.application.busyToast });
      await ctx.reply(userWorkflowBusyMessage(claim.active, 'profile-refresh', ctx.locale)); return;
    }
    await ctx.answerCallbackQuery({ text: ctx.t.cv.preparingSearchesToast });
    await ctx.editMessageReplyMarkup().catch(() => undefined);
    try {
      await refreshSearchesAfterCvUpload(userId, await startEditableIndicator(userId, ctx.t.cv.preparingSearches),
        claim.lease, ctx.locale);
    } catch (error) {
      await claim.lease.release().catch(() => undefined); throw error;
    }
  });
  instance.hears(/^\s*([a-zA-Z]{1,6})\s*$/, async (ctx) => {
    if (!ctx.from) return;
    const userId = String(ctx.from.id); const reference = ctx.match[1].toLowerCase();
    const exact = reference.length === 6 ? await getScoredVacancyByApplyId(userId, reference) : null;
    const matches: ScoredVacancy[] = reference.length === 6 ? (exact ? [exact] : [])
      : await scoredVacanciesByApplyIdPrefix(userId, reference);
    if (!matches.length) { await ctx.reply(ctx.t.search.noVacancy(reference)); return; }
    if (matches.length > 1) { await ctx.reply(ctx.t.search.ambiguous(reference)); return; }
    const vacancy = matches[0];
    // An ID no longer starts a generation on its own: the user picks which deliverable they want.
    await ctx.reply(ctx.t.search.vacancyCard(escapeHtml(vacancy.name), escapeHtml(vacancy.employer), vacancy.applyId),
      { parse_mode: 'HTML', reply_markup: applicationKeyboard(vacancy, false, ctx.locale),
        link_preview_options: { is_disabled: true } });
  });
  instance.callbackQuery('digest:noop', (ctx) => ctx.answerCallbackQuery());
  instance.callbackQuery(/^digest:page:(\d+)$/, async (ctx) => {
    const userId = String(ctx.from.id);
    const requested = Number(ctx.match[1]);
    let page = requested;
    let result = await addressableDigestPage(userId, config.digestMinScore, config.alertScore, digestPageSize, page);
    const pageCount = Math.max(1, Math.ceil(result.total / digestPageSize));
    if (page >= pageCount) { // the set shrank since the message was sent; show the last page that still exists
      page = pageCount - 1;
      result = await addressableDigestPage(userId, config.digestMinScore, config.alertScore, digestPageSize, page);
    }
    const { text, keyboard } = digestPageMessage(result.vacancies, result.allApplyIds, page, pageCount, ctx.locale);
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard,
        link_preview_options: { is_disabled: true } });
    } catch (error) {
      if (!isUnchangedMessageError(error)) throw error;
    }
    await ctx.answerCallbackQuery();
  });
  instance.callbackQuery(/^skip:(\d+)$/, async (ctx) => {
    const userId = String(ctx.from.id); const id = Number(ctx.match[1]); await skipVacancy(userId, id);
    await ctx.answerCallbackQuery({ text: ctx.t.application.skippedToast }); await ctx.deleteMessage();
  });
  instance.callbackQuery(/^(cv|letter):(\d+)$/, async (ctx) => {
    const userId = String(ctx.from.id); const artifact = ctx.match[1] as ApplicationArtifact;
    const id = Number(ctx.match[2]);
    const kind: UserWorkflowKind = artifact === 'cv' ? 'tailored-cv' : 'cover-letter';
    const claim = await claimUserWorkflow(userId, kind);
    if (!claim.claimed) {
      await ctx.answerCallbackQuery({ text: ctx.t.application.busyToast });
      await ctx.reply(userWorkflowBusyMessage(claim.active, kind, ctx.locale)); return;
    }
    let handedOver = false;
    try {
      await ctx.answerCallbackQuery({ text: `${artifactLabels(ctx.locale)[artifact].loader}…` });
      const vacancy = await getScoredVacancy(userId, id);
      // The other deliverable stays on offer, so asking for a CV does not take the letter away. The second artifact
      // request finds the markup already in that state, and an unchanged-markup error must not cost the generation.
      if (vacancy) await ctx.editMessageReplyMarkup({ reply_markup: applicationKeyboard(vacancy, false, ctx.locale) })
        .catch((error) => { if (!isUnchangedMessageError(error)) throw error; });
      handedOver = true;
      await runApplication(userId,id,String(ctx.chat?.id??ctx.from.id),artifact,claim.lease);
    } finally {
      if (!handedOver) await claim.lease.release().catch((error) =>
        console.warn(`Could not release application workflow: ${errorMessage(error)}`));
    }
  });
  instance.catch((error) => console.error(`Telegram bot error: ${errorMessage(error.error)}`));
  markBotConfigured();
  return instance;
}

/**
 * The default menu is the deployment's language; every translated locale also registers under its own Telegram
 * language code, so a client set to that language sees it without asking.
 */
async function registerTelegramCommands(instance: Bot<BotContext>): Promise<void> {
  await instance.api.deleteMyCommands();
  await instance.api.setMyCommands(commandDescriptions(defaultLocale));
  for (const locale of locales) {
    await instance.api.setMyCommands(commandDescriptions(locale), { language_code: locale });
  }
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
  const instance = currentBot();
  if (instance?.isRunning()) await instance.stop();
}
