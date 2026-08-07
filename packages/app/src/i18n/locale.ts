/**
 * The locale identity itself, kept free of both the catalogues and the configuration so that `config.ts` can parse
 * the operator default without importing a message catalogue, and the catalogues can name their own locale.
 */

export const locales = ['ru', 'en'] as const;
export type Locale = typeof locales[number];

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (locales as readonly string[]).includes(value);
}

/**
 * Telegram reports client languages as IETF tags such as `en-GB` or `ru`, and a stored preference is only ever one
 * of ours. Both are reduced to the primary subtag; anything we do not translate resolves to null so the caller can
 * fall back to the operator default rather than to a half-translated bot.
 */
export function normalizeLocale(languageCode: string | null | undefined): Locale | null {
  const primary = languageCode?.trim().toLowerCase().split(/[-_]/)[0];
  return isLocale(primary) ? primary : null;
}
