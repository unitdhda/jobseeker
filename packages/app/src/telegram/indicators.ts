import { InlineKeyboard } from 'grammy';
import { config } from '../config.ts';
import { errorMessage } from '../observability.ts';
import { messages, userLocale } from '../i18n/index.ts';
import {
  getBot,
  isMissingTelegramMessageError,
  isUnchangedMessageError,
  ownerUserId,
  retryAfterMilliseconds,
  targetChat,
} from './api.ts';


export const loaderFrames = ['⋆', '✦', '✧', '✶', '✷'] as const;
export const loaderEditIntervalMs = 1_000;
/** The task names come from the caller's catalogue, so the label is whatever that locale calls the step. */
export type LoaderTask = string;
export interface ApplicationLoader { setTask(task: LoaderTask): void; stop(): Promise<void> }
export interface EditableIndicator {
  setLabel(label: string): void;
  stop(): Promise<void>;
  /** Replaces the indicator with its own result instead of deleting it, so one message carries the whole task. */
  finish(text: string, keyboard?: InlineKeyboard): Promise<void>;
}
export type CycleStatusPhase = 'scraping' | 'filtering' | 'normalization' | 'scoring';
export interface CycleStatus { set(phase: CycleStatusPhase, current?: number, total?: number): void; stop(): Promise<void> }

export async function startEditableIndicator(userId: string, initialLabel: string): Promise<EditableIndicator | null> {
  const api = getBot().api; const chat = await targetChat(userId);
  try {
    let label = initialLabel; let frame = 0; let sentText = `${loaderFrames[frame]} ${label}`;
    let updating: Promise<void> | null = null; let blockedUntil = 0; let stopped = false;let messageMissing=false;
    let timer:ReturnType<typeof setInterval>|undefined;
    const message = await api.sendMessage(chat, `<code>${sentText}</code>`,
      { parse_mode: 'HTML', disable_notification: true });
    const update = (): void => {
      const next = `${loaderFrames[frame]} ${label}`;
      if (stopped || updating || next === sentText || Date.now() < blockedUntil) return;
      updating = api.editMessageText(chat, message.message_id, `<code>${next}</code>`, { parse_mode: 'HTML' })
        .then(() => { sentText = next; }).catch((error) => {
          if(isMissingTelegramMessageError(error)){
            messageMissing=true;stopped=true;if(timer)clearInterval(timer);return;
          }
          const delay = retryAfterMilliseconds(error);
          if (delay) blockedUntil = Date.now() + delay;
          else if (!isUnchangedMessageError(error)) console.warn(`Could not edit task indicator: ${errorMessage(error)}`);
        }).finally(() => { updating = null; });
    };
    timer = setInterval(() => { frame = (frame + 1) % loaderFrames.length; update(); }, loaderEditIntervalMs);
    const settle = async (): Promise<void> => {
      stopped = true; if (timer) clearInterval(timer); await updating;
    };
    return {
      setLabel(nextLabel) { label = nextLabel; },
      async finish(text, keyboard) {
        await settle();
        const options = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true },
          reply_markup: keyboard };
        if (!messageMissing) {
          try { await api.editMessageText(chat, message.message_id, text, options); return; }
          catch (error) {
            if (isUnchangedMessageError(error)) return;
            const delay = isMissingTelegramMessageError(error) ? 0 : retryAfterMilliseconds(error);
            if (delay) {
              await new Promise((resolve) => setTimeout(resolve, delay));
              try { await api.editMessageText(chat, message.message_id, text, options); return; }
              catch (retryError) {
                console.warn(`Could not replace task indicator after rate-limit retry: ${errorMessage(retryError)}`);
              }
            } else if (!isMissingTelegramMessageError(error)) {
              console.warn(`Could not replace task indicator: ${errorMessage(error)}`);
            }
          }
        }
        // The indicator text is still on screen when the edit fails, so the result is delivered as a new message.
        await api.sendMessage(chat, text, options);
      },
      async stop() {
        await settle();if(messageMissing)return;
        try { await api.deleteMessage(chat, message.message_id); }
        catch (error) {
          if(isMissingTelegramMessageError(error))return;
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
  // The cycle indicator is only ever shown to the owner, so it speaks the owner's language.
  const text = messages(await userLocale(ownerUserId())).cycle;
  const indicator = await startEditableIndicator(ownerUserId(), text.scraping);
  if (!indicator) return null;
  return {
    set(phase, current, total) {
      const label = text[phase];
      indicator.setLabel(current == null || total == null ? label : text.progress(label, current, total));
    },
    stop: () => indicator.stop(),
  };
}
