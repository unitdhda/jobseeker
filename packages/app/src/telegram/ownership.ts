import type { Bot } from 'grammy';
import type { Locale } from '@jobseeker/store';
import type { UserId } from '@jobseeker/engine/contracts';
import type { TelegramMode } from '../config.ts';
import { userCommands, type TelegramCommand } from './bot.ts';

export interface TelegramReceiverBot {
  init(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  handleUpdate(update: unknown): Promise<void>;
  setWebhook(url: string, secret: string): Promise<void>;
  deleteWebhook(): Promise<void>;
  deleteCommands(scope: 'default' | 'all_private_chats', locale?: Locale): Promise<void>;
  setCommands(scope: 'all_private_chats', locale: Locale | undefined, commands: readonly TelegramCommand[]): Promise<void>;
  deleteUserCommands(userId: UserId, locale?: Locale): Promise<void>;
  setUserCommands(userId: UserId, locale: Locale | undefined, commands: readonly TelegramCommand[]): Promise<void>;
}
export interface TelegramOwnership {
  readonly mode: TelegramMode;
  readonly polling: boolean;
  handleWebhook(update: unknown, secret: string | undefined): Promise<boolean>;
  stop(): Promise<void>;
}

export function grammYReceiver(bot: Bot): TelegramReceiverBot {
  return {
    init: () => bot.init(),
    start: async () => { await bot.start(); },
    stop: () => bot.stop(),
    handleUpdate: (update) => bot.handleUpdate(update as never),
    setWebhook: async (url, secret) => { await bot.api.setWebhook(url, { secret_token: secret }); },
    deleteWebhook: async () => { await bot.api.deleteWebhook(); },
    deleteCommands: async (scope, locale) => {
      await bot.api.deleteMyCommands({ ...(locale ? { language_code: locale } : {}), scope: { type: scope } });
    },
    setCommands: async (scope, locale, commands) => {
      await bot.api.setMyCommands(commands.map((command) => ({ command, description: command.replace(/_/gu, ' ') })),
        { ...(locale ? { language_code: locale } : {}), scope: { type: scope } });
    },
    deleteUserCommands: async (userId, locale) => {
      await bot.api.deleteMyCommands({ ...(locale ? { language_code: locale } : {}),
        scope: { type: 'chat', chat_id: userId } });
    },
    setUserCommands: async (userId, locale, commands) => {
      const scope = { type: 'chat' as const, chat_id: userId };
      if (commands.length === 0) {
        // Empty menus clear every language fallback previously created for this user.
        for (const language of [undefined, 'ru', 'en'] as const) {
          await bot.api.deleteMyCommands({ ...(language ? { language_code: language } : {}), scope });
        }
        return;
      }
      await bot.api.setMyCommands(commands.map((command) => ({ command, description: command.replace(/_/gu, ' ') })),
        { ...(locale ? { language_code: locale } : {}), scope });
    },
  };
}

export async function startTelegramOwnership(input: { readonly mode: TelegramMode; readonly bot: TelegramReceiverBot;
  readonly ownerUserId?: UserId; readonly webhookUrl?: string; readonly webhookSecret?: string }): Promise<TelegramOwnership> {
  if (input.mode === 'webhook' && (!input.webhookSecret || input.webhookSecret.length < 32
    || !input.webhookUrl || !/^https:\/\//u.test(input.webhookUrl))) {
    throw new TypeError('Webhook ownership requires an HTTPS URL and 32+ character secret.');
  }
  let stopped = false; let pollingRun: Promise<void> | null = null;
  if (input.mode !== 'off') {
    await input.bot.init();
    // Telegram has language-specific fallbacks; clear every app-controlled menu, including stale owner scopes.
    for (const locale of [undefined, 'ru', 'en'] as const) {
      await input.bot.deleteCommands('default', locale);
      await input.bot.deleteCommands('all_private_chats', locale);
      await input.bot.setCommands('all_private_chats', locale, userCommands);
      if (input.ownerUserId) await input.bot.deleteUserCommands(input.ownerUserId, locale);
    }
  }
  if (input.mode === 'polling') { await input.bot.deleteWebhook(); pollingRun = input.bot.start(); }
  if (input.mode === 'webhook') await input.bot.setWebhook(input.webhookUrl!, input.webhookSecret!);
  return Object.freeze({
    mode: input.mode,
    polling: input.mode === 'polling',
    async handleWebhook(update: unknown, secret: string | undefined): Promise<boolean> {
      if (stopped || input.mode !== 'webhook' || secret !== input.webhookSecret) return false;
      await input.bot.handleUpdate(update); return true;
    },
    async stop(): Promise<void> {
      if (stopped) return; stopped = true;
      if (input.mode === 'polling') { await input.bot.stop(); await pollingRun?.catch(() => undefined); }
    },
  });
}
