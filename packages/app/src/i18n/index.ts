/**
 * Locale resolution. Every user-facing string is produced by a catalogue chosen for one person, so the locale is
 * resolved at the boundary — a Telegram update, or a delivery job that only knows a user id — and passed down
 * explicitly. Nothing below the boundary guesses: the owner's `/users` table renders in the owner's language even
 * though it describes other people's accounts.
 */
import { config } from '../config.ts';
import { getTelegramUser } from '../postgres.ts';
import { en } from './en.ts';
import { ru, type Messages } from './ru.ts';
import { normalizeLocale, type Locale } from './locale.ts';

export { isLocale, locales, normalizeLocale, type Locale } from './locale.ts';
export type { Messages } from './ru.ts';

const catalogues: Record<Locale, Messages> = { ru, en };

/** The locale used for anything with no person attached, and the fallback for a language we do not translate. */
export const defaultLocale: Locale = config.defaultLocale;

export function messages(locale: Locale): Messages {
  return catalogues[locale];
}

/**
 * The stored preference wins, then the operator default. A user's Telegram client language is recorded when they
 * are first seen, so this answers the same way for a background alert as it does inside a conversation.
 */
export async function userLocale(userId: string): Promise<Locale> {
  const user = await getTelegramUser(userId);
  return normalizeLocale(user?.locale) ?? defaultLocale;
}
