import { Bot, GrammyError, HttpError, type Context } from 'grammy';
import { maximumCvBytes } from '@jobseeker/cv/extract';
import { parseUserId } from '@jobseeker/engine/contracts';
import type { Locale, TelegramIdentity } from '@jobseeker/store';

export interface TelegramSendError {
  readonly kind: 'rate-limit' | 'blocked' | 'bad-request' | 'network' | 'unknown';
  readonly retryAfterSeconds?: number;
  readonly message: string;
}

export function telegramIdentity(from: Context['from'], locale: Locale | null): TelegramIdentity {
  if (!from || from.is_bot) throw new TypeError('Telegram update has no human sender identity.');
  return Object.freeze({ userId: parseUserId(String(from.id)), username: from.username,
    firstName: from.first_name, lastName: from.last_name, ...(locale ? { locale } : {}) });
}

export function telegramSendError(error: unknown): TelegramSendError {
  if (error instanceof GrammyError) {
    const retry = typeof error.parameters.retry_after === 'number' ? error.parameters.retry_after : undefined;
    if (retry !== undefined) return Object.freeze({ kind: 'rate-limit', retryAfterSeconds: retry, message: 'Telegram rate limit.' });
    if (error.error_code === 403) return Object.freeze({ kind: 'blocked', message: 'Telegram recipient blocked the bot.' });
    return Object.freeze({ kind: 'bad-request', message: `Telegram API request failed (${error.error_code}).` });
  }
  if (error instanceof HttpError) return Object.freeze({ kind: 'network', message: 'Telegram network request failed.' });
  return Object.freeze({ kind: 'unknown', message: 'Telegram send failed.' });
}

export function createTelegramApi(token: string): Bot {
  if (!/^\d{6,12}:[A-Za-z0-9_-]{30,}$/u.test(token)) throw new TypeError('Invalid Telegram bot token syntax.');
  return new Bot(token);
}

export async function downloadTelegramFile(input: { readonly token: string; readonly filePath: string;
  readonly maximumBytes?: number; readonly fetch?: typeof globalThis.fetch }): Promise<Uint8Array> {
  const maximum = input.maximumBytes ?? maximumCvBytes;
  if (!input.filePath || input.filePath.startsWith('/') || input.filePath.includes('..')) throw new TypeError('Telegram returned an invalid file path.');
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new RangeError('Invalid Telegram download limit.');
  const response = await (input.fetch ?? globalThis.fetch)(`https://api.telegram.org/file/bot${input.token}/${input.filePath}`, { redirect: 'error' });
  if (!response.ok || !response.body) throw new Error(`Telegram file download failed (${response.status}).`);
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximum)) throw new RangeError('Telegram file exceeds the byte limit.');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const value = await reader.read(); if (value.done) break;
      total += value.value.byteLength; if (total > maximum) throw new RangeError('Telegram file exceeds the byte limit.');
      chunks.push(value.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
