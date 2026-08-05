import { Bot, InlineKeyboard, InputFile, type Context } from 'grammy';
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
  latestDigestVacanciesByApplyIdPrefix,
  listTelegramUsers,
  requestAccess,
  searchScoredVacancies,
  setUserStatus,
  skipVacancy,
  touchTelegramUser,
  userUsageSummaries,
  llmUsageSummary, scraperSummary,
  type ScoredVacancy,
  type TelegramUser,
  addressableDigestPage,
} from '@jobseeker/store';
import { importCvSource } from '../cv.ts';
import { type ApplicationArtifact } from '@jobseeker/store';
import { maximumCvBytes } from '../cv.ts';
import { errorMessage } from '../observability.ts';
import { claimTelegramSession, deleteTelegramSession, getTelegramSession, setTelegramSession } from '../telegram-state.ts';
import {
  deliverySettingsStatus,
  normalizeUtcOffset,
  parseClockMinutes,
  removeDeliveryWindow,
  updateDeliveryTimezone,
  updateDeliveryWindow,
  updateDigestTime,
} from '../vacancies/jobs.ts';
import { currentBot, getBot, identity, isBotConfigured, isUnchangedMessageError, markBotConfigured, ownerUserId, targetChat } from './api.ts';
import {
  applicationKeyboard,
  artifactLabels,
  cell,
  compactNumber,
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
  activeCvImports,
  applicationJobs,
  cvRetryKeyboard,
  cvStatus,
  downloadTelegramFile,
  finishNotice,
  pendingRefreshHashes,
  refreshSearchesAfterCvUpload,
  refreshingUsers,
  runApplication,
} from './actions.ts';


const latestUserPages = new Map<string, string[]>();
type WindowSetup = { step: 'start' | 'end' | 'digest' | 'timezone'; start?: string };
const usersPageSize = 8;
const cvUploadSessionTtlMs = 30 * 60_000;
const windowSetupTtlMs = 30 * 60_000;

function windowKeyboard():InlineKeyboard{return new InlineKeyboard()
  .text('🕒 Время уведомлений','window:time').row()
  .text('🌍 Часовой пояс','window:timezone').row()
  .text('📬 Время дайджеста','window:digest').row()
  .text('🗑 Удалить окно','window:remove');}
async function showWindowSettings(ctx:Context,userId:string):Promise<void>{
  await ctx.reply(`Настройки доставки: ${await deliverySettingsStatus(userId)}`,{reply_markup:windowKeyboard()});
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
  // Per-user counts live next to the person they describe rather than in /usage, which now reports model spend only.
  const activity = new Map((await userUsageSummaries()).map((row) => [row.userId, row]));
  const userRows = await Promise.all(users.map(async (user) => {
    const ref = user.isOwner ? '—' : userPrefix(user.userId, ids);
    const name = (user.username ? `@${user.username}` : user.displayName).replace(/\s+/g, ' ').slice(0, 24);
    const counts = activity.get(user.userId);
    return [cell(ref), cell(`${name}\n${user.userId}`), cell(userStatusText(user.status)),
      cell(await getCvSource(user.userId) ? 'да' : 'нет', 'center'),
      cell(`${counts?.scores24h ?? 0}/${counts?.scoresTotal ?? 0}\n${counts?.applications24h ?? 0}/${counts?.applicationsTotal ?? 0}`, 'right'),
      cell(await deliverySettingsStatus(user.userId))];
  }));
  const table: InputRichBlockTable = {
    type: 'table', is_bordered: true, is_striped: true,
    cells: [[headerCell('Ссылка', 'left'), headerCell('Пользователь', 'left'), headerCell('Статус', 'left'),
      headerCell('CV', 'center'), headerCell('Оценки\nОтклики', 'right'), headerCell('Доставка', 'left')], ...userRows],
  };
  const richMessage: InputRichMessage = { blocks: [
    { type: 'heading', size: 3, text: `Пользователи — страница ${page + 1}/${pages}` },
    table,
    { type: 'paragraph', text: 'Оценки и отклики: за 24 часа / за всё время.' },
    { type: 'paragraph', text: 'Одобрить: /ok ID или @username. Отозвать: /revoke ССЫЛКА.' },
  ] };
  const keyboard = new InlineKeyboard();
  if (page > 0) keyboard.text('‹ Назад', `users-page:${page - 1}`);
  if (page + 1 < pages) keyboard.text('Далее ›', `users-page:${page + 1}`);
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

async function showUsers(ctx: Context, page: number, edit = false): Promise<number | undefined> {
  const view = await usersPage(page); latestUserPages.set(ownerUserId(), view.ids);
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
    ? '\n\nКоманды владельца:\n/ok ID или @username — одобрить доступ\n/users — пользователи и их активность\n'
      + '/revoke ССЫЛКА — отозвать доступ\n/usage — токены и стоимость модели\n/scraper — здоровье скрейпера и парсера\n/status — развёртывание и облако'
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
  if (isBotConfigured()) return instance;
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
      await ctx.deleteMessage().catch(() => undefined);
      return;
    }
    const user = await setUserStatus(userId, action === 'approve' ? 'approved' : 'rejected');
    if (!user) throw new Error('Telegram user disappeared during access update.');
    await ctx.answerCallbackQuery({ text: action === 'approve' ? 'Доступ одобрен' : 'Заявка отклонена' });
    // The decision is confirmed by the callback toast, so the spent request card is removed rather than left behind.
    await ctx.deleteMessage().catch(() => undefined);
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
    await dropTrackedMessages(ownerUserId(), 'users-messages');
    const page = Math.max(0, Number.parseInt(ctx.match.trim(), 10) - 1 || 0);
    const sent = await showUsers(ctx, page);
    await trackMessages(ownerUserId(), 'users-messages', [ctx.message?.message_id, sent]);
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
    const [llm,settings]=await Promise.all([llmUsageSummary(),getDeliverySettings(ownerUserId())]);
    const chart=usageTimelineChart(llm.hourlyTimeline,settings?.timezone??config.timezone);
    await dropTrackedMessages(ownerUserId(), 'usage-messages');
    const sent = await ctx.reply(`<b>Использование — 24 часа / всё время</b>\n`+
      `LLM-вызовы: <b>${llm.turns24h} / ${llm.turnsTotal}</b>\n`+
      `Токены: <b>${compactNumber(llm.tokens24h)} / ${compactNumber(llm.tokensTotal)}</b>\n`+
      `Стоимость модели: <b>${money(llm.cost24hUsd)} / ${money(llm.costTotalUsd)}</b>\n\n`+
      `<b>Почасовая динамика за 24 часа</b>\n<pre>${escapeHtml(chart)}</pre>`,
      { parse_mode: 'HTML' });
    await trackMessages(ownerUserId(), 'usage-messages', [ctx.message?.message_id, sent.message_id]);
  });
  instance.command('scraper', async (ctx) => {
    if (String(ctx.from?.id) !== ownerUserId()) { await ctx.reply('Эта команда доступна только владельцу.'); return; }
    const [summary,settings]=await Promise.all([scraperSummary(),getDeliverySettings(ownerUserId())]);
    const chart=scraperTimelineChart(summary.hourly,settings?.timezone??config.timezone);
    await dropTrackedMessages(ownerUserId(), 'scraper-messages');
    const sent = await ctx.reply(`${scraperStatusMessage(summary)}\n\n`+
      `<b>Почасовая динамика за 24 часа</b>\n<pre>${escapeHtml(chart)}</pre>`,
      { parse_mode: 'HTML' });
    await trackMessages(ownerUserId(), 'scraper-messages', [ctx.message?.message_id, sent.message_id]);
  });
  instance.command('status', async (ctx) => {
    if (String(ctx.from?.id) !== ownerUserId()) { await ctx.reply('Эта команда доступна только владельцу.'); return; }
    await dropTrackedMessages(ownerUserId(), 'status-messages');
    const sent = await ctx.reply(`<b>Развёртывание и облако</b>\n<pre>${escapeHtml(deploymentStatusText())}</pre>`,
      { parse_mode: 'HTML' });
    await trackMessages(ownerUserId(), 'status-messages', [ctx.message?.message_id, sent.message_id]);
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
    const userId=String(ctx.from!.id);await deleteTelegramSession(userId,'window-setup');await showWindowSettings(ctx,userId);
  });
  instance.callbackQuery(/^window:(time|timezone|digest|remove)$/,async(ctx)=>{
    const userId=String(ctx.from.id),action=ctx.match[1];await ctx.answerCallbackQuery();
    await deleteTelegramSession(userId,'window-setup');
    if(action==='remove'){
      await removeDeliveryWindow(userId);await ctx.reply(`Окно уведомлений удалено. ${await deliverySettingsStatus(userId)}`,
        {reply_markup:windowKeyboard()});return;
    }
    if(action==='time'){
      await setTelegramSession(userId,'window-setup',{step:'start'} satisfies WindowSetup,windowSetupTtlMs);
      await ctx.reply('Во сколько начинать уведомления? Отправьте время ЧЧ:ММ, например 09:00.');return;
    }
    if(action==='timezone'){
      await setTelegramSession(userId,'window-setup',{step:'timezone'} satisfies WindowSetup,windowSetupTtlMs);
      await ctx.reply('Укажите смещение от UTC: например +3, -5 или +3:30.');return;
    }
    await setTelegramSession(userId,'window-setup',{step:'digest'} satisfies WindowSetup,windowSetupTtlMs);
    await ctx.reply('Во сколько присылать ежедневную подборку? Отправьте время ЧЧ:ММ, например 09:30.');
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
        parseClockMinutes(value); await setTelegramSession(userId, 'window-setup', { step: 'end', start: value } satisfies WindowSetup, windowSetupTtlMs);
        await ctx.reply('Во сколько заканчивать уведомления? Отправьте время ЧЧ:ММ, например 22:00.');
      } else if (setup.step === 'end') {
        await updateDeliveryWindow(userId,setup.start!,value);await deleteTelegramSession(userId,'window-setup');
        await ctx.reply(`Время уведомлений сохранено. ${await deliverySettingsStatus(userId)}`,{reply_markup:windowKeyboard()});
      } else if (setup.step === 'digest') {
        await updateDigestTime(userId,value);await deleteTelegramSession(userId,'window-setup');
        await ctx.reply(`Время дайджеста сохранено. ${await deliverySettingsStatus(userId)}`,{reply_markup:windowKeyboard()});
      } else {
        await updateDeliveryTimezone(userId,normalizeUtcOffset(value));await deleteTelegramSession(userId,'window-setup');
        await ctx.reply(`Часовой пояс сохранён. ${await deliverySettingsStatus(userId)}`,{reply_markup:windowKeyboard()});
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
    let indicator: EditableIndicator | null = null;
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
      indicator = await startEditableIndicator(userId, 'Загружаю файл');
      const bytes = await downloadTelegramFile(document.file_id, document.file_size);
      indicator?.setLabel('Разбираю резюме');
      await importCvSource(userId, filename, document.mime_type, bytes);
      await deleteTelegramSession(userId, 'cv-upload');
      indicator?.setLabel('Резюме сохранено · готовлю поисковые запросы');
      const handedOver = indicator; indicator = null;
      await refreshSearchesAfterCvUpload(userId, handedOver);
    } catch (error) {
      console.error(`CV import failed for user ${userId}: ${errorMessage(error)}`);
      if (await isApprovedUser(userId)) {
        await finishNotice(userId, indicator, 'Не удалось обработать файл. Проверьте формат и размер, затем попробуйте снова.',
          cvRetryKeyboard('cv:retry'));
      } else await indicator?.stop().catch((stopError) => console.warn(`Could not stop CV indicator: ${errorMessage(stopError)}`));
    } finally { activeCvImports.delete(userId); }
  });
  instance.callbackQuery('cv:retry', async (ctx) => {
    const userId = String(ctx.from.id);
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup().catch(() => undefined);
    // The upload cooldown was already claimed for this attempt, so a retry only re-arms the upload session.
    await setTelegramSession(userId, 'cv-upload', {}, cvUploadSessionTtlMs);
    await ctx.reply('Пришлите резюме одним файлом ещё раз: PDF, Markdown, TXT или DOCX до 20 МБ.');
  });
  instance.callbackQuery('cv:refresh', async (ctx) => {
    const userId = String(ctx.from.id);
    await ctx.answerCallbackQuery({ text: 'Готовлю поисковые запросы…' });
    await ctx.editMessageReplyMarkup().catch(() => undefined);
    await refreshSearchesAfterCvUpload(userId, await startEditableIndicator(userId, 'Готовлю поисковые запросы'));
  });
  instance.hears(/^\s*([a-zA-Z]{1,6})\s*$/, async (ctx) => {
    if (!ctx.from) return;
    const userId = String(ctx.from.id); const reference = ctx.match[1].toLowerCase();
    const exact = reference.length === 6 ? await getScoredVacancyByApplyId(userId, reference) : null;
    const matches: ScoredVacancy[] = reference.length === 6 ? (exact ? [exact] : [])
      : await latestDigestVacanciesByApplyIdPrefix(userId, config.digestMinScore, config.alertScore, reference);
    if (!matches.length) { await ctx.reply(`В последней подборке нет вакансии с ID ${reference}.`); return; }
    if (matches.length > 1) { await ctx.reply(`Префикс ${reference} подходит к нескольким вакансиям. Пришлите больше букв.`); return; }
    const vacancy = matches[0];
    if ([...applicationJobs].some((key) => key.startsWith(`${userId}:${vacancy.id}:`))) {
      await ctx.reply(`Документы для ${vacancy.applyId} уже готовятся.`); return;
    }
    // An ID no longer starts a generation on its own: the user picks which deliverable they want.
    await ctx.reply(`<b>${escapeHtml(vacancy.name)}</b>\n${escapeHtml(vacancy.employer)} · <code>${vacancy.applyId}</code>`,
      { parse_mode: 'HTML', reply_markup: applicationKeyboard(vacancy, false), link_preview_options: { is_disabled: true } });
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
    const { text, keyboard } = digestPageMessage(result.vacancies, result.allApplyIds, page, pageCount);
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
    await ctx.answerCallbackQuery({ text: 'Вакансия пропущена' }); await ctx.deleteMessage();
  });
  instance.callbackQuery(/^(cv|letter):(\d+)$/, async (ctx) => {
    const userId = String(ctx.from.id); const artifact = ctx.match[1] as ApplicationArtifact;
    const id = Number(ctx.match[2]);
    await ctx.answerCallbackQuery({ text: `${artifactLabels[artifact].loader}…` });
    const vacancy = await getScoredVacancy(userId, id);
    // The other deliverable stays on offer, so asking for a CV does not take the letter away. The second artifact
    // request finds the markup already in that state, and an unchanged-markup error must not cost the generation.
    if (vacancy) await ctx.editMessageReplyMarkup({ reply_markup: applicationKeyboard(vacancy, false) })
      .catch((error) => { if (!isUnchangedMessageError(error)) throw error; });
    await runApplication(userId,id,String(ctx.chat?.id??ctx.from.id),artifact);
  });
  instance.catch((error) => console.error(`Telegram bot error: ${errorMessage(error.error)}`));
  markBotConfigured();
  return instance;
}

async function registerTelegramCommands(instance: Bot): Promise<void> {
  await instance.api.deleteMyCommands();
  await instance.api.setMyCommands([
    { command: 'start', description: 'Начало работы и статус' },
    { command: 'request', description: 'Запросить доступ' },
    { command: 'cv', description: 'Загрузить или заменить резюме' },
    { command: 'privacy', description: 'Как обрабатываются данные' },
    { command: 'window', description: 'Настроить время уведомлений' },
    { command: 'digest', description: 'Состояние ежедневного дайджеста' },
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
  const instance = currentBot();
  if (instance?.isRunning()) await instance.stop();
}
