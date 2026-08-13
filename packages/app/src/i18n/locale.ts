import type { Locale } from '@jobseeker/store';

export function supportedLocale(value: string | undefined | null): Locale | null {
  const primary = value?.trim().toLowerCase().split(/[-_]/u)[0];
  return primary === 'ru' || primary === 'en' ? primary : null;
}

export function resolveLocale(input: {
  readonly stored: Locale | null;
  readonly explicitlySelected: boolean;
  readonly clientLanguage?: string;
  readonly defaultLocale: Locale;
}): Locale {
  if (input.explicitlySelected && input.stored) return input.stored;
  return supportedLocale(input.clientLanguage) ?? input.stored ?? input.defaultLocale;
}
