import type { Locale, ScoredVacancy, Store, TelegramUser } from '@jobseeker/store';
import type { UserId } from '@jobseeker/engine/contracts';
import { messages } from '../i18n/index.ts';
import { formatApplyIdWithUniquePrefix, normalizeApplyIdPrefix } from './digest-page.ts';
import { escapeHtml, formatNumber } from './format.ts';

export interface MatchCodeButton {
  readonly text: string;
  readonly url?: string;
  readonly callbackData?: string;
}

export interface MatchCodeTransport {
  reply(userId: UserId, html: string, buttons?: readonly MatchCodeButton[]): Promise<void>;
}

export interface MatchCodeContext {
  readonly text: string;
  readonly user: TelegramUser;
  readonly locale: Locale;
}

export interface MatchCodePorts {
  readonly store: Pick<Store, 'scoredVacanciesByApplyIdPrefix' | 'scoredVacancyApplyIds'>;
  readonly transport: MatchCodeTransport;
}

export type MatchCodeResult = 'not-found' | 'ambiguous' | 'matched';

export function formatRetrievedMatch(vacancy: ScoredVacancy, scoredApplyIds: readonly string[], locale: Locale): string {
  const t = messages(locale);
  return [
    `${formatApplyIdWithUniquePrefix(vacancy.applyId, scoredApplyIds)} · <b>${escapeHtml(vacancy.name)}</b>`,
    escapeHtml(vacancy.employer),
    `${t.scoreLabel}: <b>${formatNumber(vacancy.score, locale)}</b>/100`,
  ].join('\n');
}

export async function retrieveMatchByCode(input: MatchCodeContext, ports: MatchCodePorts): Promise<MatchCodeResult> {
  const t = messages(input.locale);
  const prefix = normalizeApplyIdPrefix(input.text);
  if (!prefix) {
    await ports.transport.reply(input.user.userId, t.matchCodeNotFound);
    return 'not-found';
  }
  const matches = await ports.store.scoredVacanciesByApplyIdPrefix(input.user.userId, prefix);
  if (matches.length === 0) {
    await ports.transport.reply(input.user.userId, t.matchCodeNotFound);
    return 'not-found';
  }
  if (matches.length > 1) {
    await ports.transport.reply(input.user.userId, t.matchCodeAmbiguous);
    return 'ambiguous';
  }
  const vacancy = matches[0]!;
  const scoredApplyIds = await ports.store.scoredVacancyApplyIds(input.user.userId);
  await ports.transport.reply(input.user.userId, formatRetrievedMatch(vacancy, scoredApplyIds, input.locale), [
    { text: t.buttonSource, url: vacancy.url.href },
    { text: t.buttonLetter, callbackData: `apply:letter:${vacancy.id}` },
    { text: t.buttonCv, callbackData: `apply:cv:${vacancy.id}` },
  ]);
  return 'matched';
}
