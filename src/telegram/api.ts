import { Bot, type Context } from 'grammy';
import { config } from '../config.ts';
import { getTelegramUser, type TelegramIdentity } from '../database.ts';


let bot: Bot | undefined;
let botConfigured = false;
export function getBot(): Bot {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required.');
  return bot ??= new Bot(token);
}
export function ownerUserId(): string {
  if (!config.telegramUserId) throw new Error('TELEGRAM_USER_ID is required for the bot owner.');
  return config.telegramUserId;
}
export async function targetChat(userId: string): Promise<string> {
  const user = await getTelegramUser(userId);
  if (!user) throw new Error(`Telegram user ${userId} was not found.`);
  return user.chatId;
}
export function identity(ctx: Context): TelegramIdentity | null {
  if (!ctx.from || !ctx.chat || ctx.chat.type !== 'private') return null;
  const displayName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || ctx.from.username || String(ctx.from.id);
  return { userId: String(ctx.from.id), chatId: String(ctx.chat.id), username: ctx.from.username, displayName };
}
export function telegramRetryAfter(error:unknown):number|null{
  const value=error as {error_code?:unknown;parameters?:{retry_after?:unknown};message?:unknown};
  if(value?.error_code!==429&&!/429: Too Many Requests/i.test(String(value?.message??error)))return null;
  const seconds=Number(value?.parameters?.retry_after);return Number.isFinite(seconds)&&seconds>0?seconds:1;
}

export function retryAfterMilliseconds(error: unknown): number {
  const seconds = Number((error as { parameters?: { retry_after?: number } })?.parameters?.retry_after ?? 0);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 + 250 : 0;
}
export function isUnchangedMessageError(error: unknown): boolean {
  return /message is not modified/i.test(error instanceof Error ? error.message : String(error));
}
export function isMissingTelegramMessageError(error:unknown):boolean{
  return /message to edit not found|message to delete not found|message can't be edited|message_id_invalid/i
    .test(error instanceof Error?error.message:String(error));
}
/**
 * Progress indicators are transient status, not something to be woken up for: cycles run around the clock and CV
 * tailoring is already in the foreground for the user who asked. They are sent without a notification and are not
 * gated by the delivery window, which applies only to alerts and digests.
 */

export function isBotConfigured(): boolean { return botConfigured; }
export function markBotConfigured(): void { botConfigured = true; }

/** The lifecycle needs to stop only a bot that was ever created; getBot would create one just to stop it. */
export function currentBot(): Bot | undefined { return bot; }
