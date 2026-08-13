import type { Locale } from '@jobseeker/store';
import { escapeHtml, splitTelegramHtml } from './format.ts';

function collectStrings(value: unknown, keyHint = '', output: string[] = []): string[] {
  if (typeof value === 'string') {
    if (/^(?:query|text|name|title|category|role)$/iu.test(keyHint) && value.trim()) output.push(value.trim());
    return output;
  }
  if (Array.isArray(value)) { for (const item of value) collectStrings(item, keyHint, output); return output; }
  if (typeof value !== 'object' || value === null) return output;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) collectStrings(item, key, output);
  return output;
}

export function profileSearchTerms(profile: unknown): readonly string[] {
  const seen = new Set<string>(); const output: string[] = [];
  for (const value of collectStrings(profile)) {
    const cleaned = value.normalize('NFC').replace(/\s+/gu, ' ').trim().slice(0, 300);
    const key = cleaned.toLocaleLowerCase('und');
    if (!cleaned || seen.has(key)) continue; seen.add(key); output.push(cleaned);
    if (output.length === 30) break;
  }
  return Object.freeze(output);
}

export function searchProfileMessage(profiles: Readonly<Record<string, unknown>>, configuredSources: readonly string[],
  locale: Locale): readonly string[] {
  const lines = [`<b>${locale === 'ru' ? 'Профили поиска' : 'Search profiles'}</b>`];
  for (const source of configuredSources) {
    const terms = profileSearchTerms(profiles[source]);
    lines.push('', `<b>${escapeHtml(source)}</b>`);
    lines.push(...(terms.length ? terms.map((term) => `• ${escapeHtml(term)}`) : [locale === 'ru' ? '• нет запросов' : '• no searches']));
  }
  return splitTelegramHtml(lines);
}
