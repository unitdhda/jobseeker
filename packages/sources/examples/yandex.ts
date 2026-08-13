import type { CompanyListingPage, CompanySite } from '@jobseeker/sources/drivers/company-site';
import { arrayAt, textAt, dateAt } from './api-example.ts';
import { createCompanySiteSource, examplePages, initToolkit, type SourceExtensionApi } from './toolkit.ts';

export function yandexCursor(value: unknown): string | undefined {
  const raw = textAt(value); if (!raw) return undefined;
  try { return new URL(raw, 'https://yandex.ru').searchParams.get('cursor') || raw; } catch { return undefined; }
}
export function yandexSearchUrl(query: string, cursor?: string): string {
  const url = new URL('/jobs/api/jobs/publications', 'https://yandex.ru');
  url.searchParams.set('text', query); if (cursor) url.searchParams.set('cursor', cursor); return url.href;
}
export function yandexListingPage(payload: unknown): CompanyListingPage {
  const items = arrayAt(payload, 'items');
  return { listings: items.map((item) => ({ sourceId: textAt(item, 'id'),
    url: `https://yandex.ru/jobs/vacancies/${textAt(item, 'id')}`, title: textAt(item, 'title'),
    summary: textAt(item, 'shortDescription'), employer: 'Яндекс', area: textAt(item, 'location'),
    experience: textAt(item, 'experience'), employment: textAt(item, 'employment'),
    workFormat: textAt(item, 'workFormat'), keySkills: arrayAt(item, 'skills').map((skill) => textAt(skill, 'name')),
    publishedAt: dateAt(item, 'publishedAt') })), ...(yandexCursor(textAt(payload, 'next')) ? { nextCursor: yandexCursor(textAt(payload, 'next')) } : {}) };
}
export const yandexCompanySite: CompanySite = {
  id: 'yandex', name: 'Yandex Jobs', employer: 'Яндекс', hosts: ['yandex.ru'], queryLanguage: 'Russian or English',
  searchUrl: yandexSearchUrl, listingPage: yandexListingPage,
  rules: ['Use technology role titles used by Yandex.'],
};
export function yandexSource(options: { readonly maxPages?: number } = {}) { return createCompanySiteSource(yandexCompanySite, options); }
export default function register(api: SourceExtensionApi): void { initToolkit(api); api.registerSourceProvider(yandexSource({ maxPages: examplePages(api) })); }
