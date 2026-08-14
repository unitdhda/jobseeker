import type { Bot, Context } from 'grammy';
import type { Locale, TelegramIdentity, TelegramUser } from '@jobseeker/store';
import { parseUserId, type UserId } from '@jobseeker/engine/contracts';
import { messages, resolveLocale, supportedLocale, type Catalogue } from '../i18n/index.ts';
import { telegramIdentity } from './api.ts';

export const publicCommands = Object.freeze(['start', 'request', 'language'] as const);
export const approvedCommands = Object.freeze(['cv', 'window', 'digest', 'search', 'privacy', 'export_me', 'delete_me'] as const);
export const ownerCommands = Object.freeze(['ok', 'users', 'revoke', 'usage', 'scraper', 'status'] as const);
export const userCommands = Object.freeze([...publicCommands, ...approvedCommands] as const);
export type PublicCommand = typeof publicCommands[number];
export type ApprovedCommand = typeof approvedCommands[number];
export type OwnerCommand = typeof ownerCommands[number];
export type TelegramCommand = PublicCommand | ApprovedCommand | OwnerCommand;

export interface TelegramAccessPorts {
  getTelegramUser(userId: UserId): Promise<TelegramUser | null>;
  touchTelegramUser(identity: TelegramIdentity): Promise<TelegramUser>;
  requestAccess(identity: TelegramIdentity): Promise<{ readonly user: TelegramUser; readonly notifyOwner: boolean; readonly retryAfterSeconds: number }>;
  setUserLocale(userId: UserId, locale: Locale): Promise<TelegramUser | null>;
}
export interface TelegramUpdateInput {
  readonly chatType: string;
  readonly messageId?: number;
  readonly text?: string;
  readonly from?: { readonly id: number; readonly isBot?: boolean; readonly username?: string; readonly firstName: string;
    readonly lastName?: string; readonly languageCode?: string };
}
export interface TelegramResponsePort {
  reply(text: string, options?: { readonly locale?: Locale; readonly command?: TelegramCommand }): Promise<void> | void;
  notifyOwner?(text: string): Promise<void> | void;
  setCommands?(locale: Locale, commands: readonly TelegramCommand[]): Promise<void> | void;
}
export interface RoutedTelegramContext {
  readonly command: TelegramCommand;
  readonly argument: string;
  readonly user: TelegramUser | null;
  readonly locale: Locale;
  readonly t: Catalogue;
  readonly messageId?: number;
  readonly ownerCommand?: boolean;
}
export interface TelegramCommandHandlers {
  readonly approved?: Partial<Record<ApprovedCommand, (context: RoutedTelegramContext) => Promise<void> | void>>;
  readonly owner?: Partial<Record<OwnerCommand, (context: RoutedTelegramContext) => Promise<void> | void>>;
}

function commandOf(text: string | undefined): { readonly command: TelegramCommand; readonly argument: string } | null {
  const match = /^\/([a-z_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/u.exec(text?.trim() ?? '');
  const command = match?.[1];
  return command && [...publicCommands, ...approvedCommands, ...ownerCommands].includes(command as TelegramCommand)
    ? Object.freeze({ command: command as TelegramCommand, argument: match?.[2]?.trim() ?? '' }) : null;
}
function identity(input: NonNullable<TelegramUpdateInput['from']>, locale: Locale | null): TelegramIdentity {
  if (input.isBot) throw new TypeError('Bot senders are not users.');
  return Object.freeze({ userId: parseUserId(String(input.id)), username: input.username,
    firstName: input.firstName, lastName: input.lastName, ...(locale ? { locale } : {}) });
}
function menuFor(user: TelegramUser): readonly TelegramCommand[] {
  // Administrative commands stay hidden; approved users and the owner receive the ordinary user menu.
  return user.status === 'approved' ? userCommands : publicCommands;
}

export async function routeTelegramUpdate(input: TelegramUpdateInput, ports: TelegramAccessPorts,
  response: TelegramResponsePort, defaultLocale: Locale, handlers: TelegramCommandHandlers = {}): Promise<RoutedTelegramContext | null> {
  if (input.chatType !== 'private') { await response.reply(messages(defaultLocale).privateOnly); return null; }
  if (!input.from || input.from.isBot) return null;
  const parsedCommand = commandOf(input.text);
  const command = parsedCommand?.command ?? null;
  const argument = parsedCommand?.argument ?? '';
  const clientLocale = supportedLocale(input.from.languageCode);
  const preliminaryLocale = clientLocale ?? defaultLocale;
  const sender = identity(input.from, clientLocale);

  // Unknown arbitrary senders never create rows. Only public commands cross this read boundary.
  const existing = await ports.getTelegramUser(sender.userId);
  if (!existing && command !== 'start' && command !== 'request' && command !== 'language') return null;
  const locale = resolveLocale({ stored: existing?.locale ?? null, explicitlySelected: existing?.localeSelected ?? false,
    clientLanguage: input.from.languageCode, defaultLocale });
  const t = messages(locale);

  if (command === 'start') {
    const user = existing ?? await ports.touchTelegramUser(sender);
    const text = user.status === 'approved' ? t.startApproved : user.status === 'pending' ? t.startPending : t.startUnknown;
    await response.reply(text, { locale, command });
    return Object.freeze({ command, argument, user, locale, t, messageId: input.messageId, ownerCommand: false });
  }
  if (command === 'request') {
    const result = await ports.requestAccess(sender);
    await response.reply(result.retryAfterSeconds > 0 ? t.accessCooldown(result.retryAfterSeconds)
      : result.user.status === 'approved' ? t.startApproved : result.user.status === 'pending' && !result.notifyOwner
        ? t.startPending : t.accessRequested, { locale, command });
    if (result.notifyOwner) await response.notifyOwner?.(`Access request: ${result.user.userId}`);
    return Object.freeze({ command, argument, user: result.user, locale, t, messageId: input.messageId, ownerCommand: false });
  }
  if (command === 'language') {
    const selected: Locale = locale === 'ru' ? 'en' : 'ru';
    const user = existing ?? await ports.touchTelegramUser(sender);
    const updated = await ports.setUserLocale(user.userId, selected);
    await response.setCommands?.(selected, updated ? menuFor(updated) : publicCommands);
    await response.reply(messages(selected).languageChanged, { locale: selected, command });
    return Object.freeze({ command, argument, user: updated ?? user, locale: selected, t: messages(selected), messageId: input.messageId, ownerCommand: false });
  }
  if (!command) return null;
  if (!existing || existing.status !== 'approved') { await response.reply(t.accessDenied, { locale }); return null; }
  const ownerCommand = (ownerCommands as readonly string[]).includes(command);
  if (ownerCommand && !existing.isOwner) { await response.reply(t.accessDenied, { locale }); return null; }

  // Authorized updates touch identity exactly once, after both access and owner checks pass.
  const user = await ports.touchTelegramUser(identity(input.from, clientLocale));
  const context = Object.freeze({ command, argument, user, locale, t, messageId: input.messageId, ownerCommand });
  if (ownerCommand) {
    await handlers.owner?.[command as OwnerCommand]?.(context); return context;
  }
  await handlers.approved?.[command as ApprovedCommand]?.(context); return context;
}

export interface TelegramRouteOptions {
  readonly handlers?: TelegramCommandHandlers;
  readonly setCommands?: (userId: UserId, locale: Locale, commands: readonly TelegramCommand[]) => Promise<void>;
  readonly notifyOwner?: (text: string) => Promise<void>;
  readonly document?: (input: { readonly user: TelegramUser; readonly locale: Locale; readonly fileId: string;
    readonly filename: string; readonly mediaType?: string; readonly declaredSize: number }) => Promise<void>;
  readonly callback?: (input: { readonly data: string; readonly senderId: number; readonly languageCode?: string;
    answer(text?: string): Promise<void>; edit(html: string): Promise<void> }) => Promise<void>;
}

export function installTelegramRoutes(bot: Bot, ports: TelegramAccessPorts, defaultLocale: Locale,
  options: TelegramRouteOptions = {}): void {
  bot.on('message', async (ctx: Context) => {
    const from = ctx.from;
    if (ctx.chat?.type === 'private' && from && !from.is_bot && ctx.message?.document && options.document) {
      const userId = parseUserId(String(from.id)); const existing = await ports.getTelegramUser(userId);
      if (!existing || existing.status !== 'approved') { if (existing) await ctx.reply(messages(defaultLocale).accessDenied); return; }
      const locale = resolveLocale({ stored: existing.locale, explicitlySelected: existing.localeSelected,
        clientLanguage: from.language_code, defaultLocale });
      const user = await ports.touchTelegramUser(identity({ id: from.id, isBot: from.is_bot, username: from.username,
        firstName: from.first_name, lastName: from.last_name, languageCode: from.language_code }, supportedLocale(from.language_code)));
      await options.document({ user, locale, fileId: ctx.message.document.file_id,
        filename: ctx.message.document.file_name ?? '', mediaType: ctx.message.document.mime_type,
        declaredSize: ctx.message.document.file_size ?? 0 });
      return;
    }
    await routeTelegramUpdate({ chatType: ctx.chat?.type ?? '', messageId: ctx.message?.message_id, text: ctx.message?.text,
      from: from ? { id: from.id, isBot: from.is_bot, username: from.username,
        firstName: from.first_name, lastName: from.last_name, languageCode: from.language_code } : undefined },
    ports, { reply: async (text) => { await ctx.reply(text, { parse_mode: 'HTML' }); }, notifyOwner: options.notifyOwner,
      setCommands: async (locale, commands) => { if (from) await options.setCommands?.(parseUserId(String(from.id)), locale, commands); } },
    defaultLocale, options.handlers);
  });
  if (options.callback) bot.on('callback_query:data', async (ctx) => {
    await options.callback!({ data: ctx.callbackQuery.data, senderId: ctx.from.id, languageCode: ctx.from.language_code,
      answer: async (text) => { await ctx.answerCallbackQuery(text ? { text } : undefined); },
      edit: async (html) => { await ctx.editMessageText(html, { parse_mode: 'HTML' }); } });
  });
}

export function identityFromContext(ctx: Context, locale: Locale | null): TelegramIdentity {
  return telegramIdentity(ctx.from, locale);
}
