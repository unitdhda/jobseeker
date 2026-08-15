import type { Locale, ScoredVacancy } from '@jobseeker/store';
import type { SalaryRange } from '@jobseeker/engine/contracts';
import { messages } from '../i18n/index.ts';
import { formatApplyIdWithUniquePrefix } from './digest-page.ts';

export function escapeHtml(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');
}
export function telegramLink(label: string, url: URL): string {
  if (!(url instanceof URL) || !['https:', 'http:'].includes(url.protocol)) throw new TypeError('Invalid Telegram link URL.');
  return `<a href="${escapeHtml(url.href)}">${escapeHtml(label)}</a>`;
}

export function formatNumber(value: number, locale: Locale, maximumFractionDigits = 0): string {
  if (!Number.isFinite(value) || !Number.isSafeInteger(maximumFractionDigits) || maximumFractionDigits < 0 || maximumFractionDigits > 6) {
    throw new TypeError('Invalid localized number.');
  }
  return new Intl.NumberFormat(locale, { maximumFractionDigits }).format(value);
}
const periodLabels: Readonly<Record<Locale, Readonly<Record<SalaryRange['period'], string>>>> = {
  ru: { hour: 'в час', day: 'в день', week: 'в неделю', month: 'в месяц', year: 'в год', unspecified: '' },
  en: { hour: 'per hour', day: 'per day', week: 'per week', month: 'per month', year: 'per year', unspecified: '' },
};
export function formatSalary(salary: SalaryRange | null, locale: Locale): string {
  if (!salary) return messages(locale).salaryUnknown;
  const currency = escapeHtml(salary.currency);
  const from = salary.from === null ? null : formatNumber(salary.from, locale);
  const to = salary.to === null ? null : formatNumber(salary.to, locale);
  const amount = from !== null && to !== null ? `${from}–${to}` : from !== null ? `${locale === 'ru' ? 'от' : 'from'} ${from}`
    : `${locale === 'ru' ? 'до' : 'up to'} ${to}`;
  const gross = salary.gross === null ? '' : salary.gross ? (locale === 'ru' ? ' до вычета' : ' gross') : (locale === 'ru' ? ' на руки' : ' net');
  const period = periodLabels[locale][salary.period];
  return `${amount} ${currency}${gross}${period ? ` ${period}` : ''}`;
}

export function formatDate(value: Date, locale: Locale, timezone: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError('Invalid localized date.');
  return new Intl.DateTimeFormat(locale, { timeZone: timezone, day: '2-digit', month: 'short', year: 'numeric' }).format(value);
}
export function formatTime(value: Date, locale: Locale, timezone: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError('Invalid localized time.');
  return new Intl.DateTimeFormat(locale, { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(value);
}
export function formatDuration(milliseconds: number, locale: Locale): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new RangeError('Invalid duration.');
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds} ${locale === 'ru' ? 'с' : 's'}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} ${locale === 'ru' ? 'мин' : 'min'}`;
  const hours = Math.round(minutes / 60);
  return `${hours} ${locale === 'ru' ? 'ч' : 'h'}`;
}
export function formatStatus(status: 'running' | 'idle' | 'off', locale: Locale): string {
  const catalogue = messages(locale);
  return status === 'running' ? catalogue.statusRunning : status === 'idle' ? catalogue.statusIdle : catalogue.statusOff;
}

function lines(values: readonly string[], maximum: number): string[] {
  return values.slice(0, maximum).map((value) => `• ${escapeHtml(value)}`);
}
export function formatDigestVacancy(vacancy: ScoredVacancy, scoredApplyIds: readonly string[], locale: Locale): string {
  const t = messages(locale);
  const heading = `${formatApplyIdWithUniquePrefix(vacancy.applyId, scoredApplyIds)} · <b>${escapeHtml(vacancy.name)}</b>`;
  const employer = `${escapeHtml(vacancy.employer)} · ${escapeHtml(vacancy.area)}`;
  const metadata = `${t.scoreLabel}: <b>${formatNumber(vacancy.score, locale)}</b> · ${formatSalary(vacancy.salary, locale)}`;
  const details = [vacancy.summary ? escapeHtml(vacancy.summary) : '',
    ...(vacancy.reasons.length ? [`<b>${t.reasonsLabel}</b>`, ...lines(vacancy.reasons, 3)] : []),
    ...(vacancy.gaps.length ? [`<b>${t.gapsLabel}</b>`, ...lines(vacancy.gaps, 2)] : [])].filter(Boolean);
  return [heading, employer, metadata, ...details].join('\n');
}

export function splitTelegramHtml(linesInput: readonly string[], maximum = 4_096): readonly string[] {
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new RangeError('Invalid Telegram message limit.');
  const output: string[] = []; let current = '';
  for (const line of linesInput) {
    if (line.length > maximum) throw new RangeError('One Telegram output line exceeds the message limit.');
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > maximum) { output.push(current); current = line; } else current = candidate;
  }
  if (current) output.push(current);
  return Object.freeze(output);
}
