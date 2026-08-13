import type { VacancyCandidate, VacancyInput } from '@jobseeker/engine/contracts';
import type { CompanyListingPage, CompanySite } from '@jobseeker/sources/drivers/company-site';
import { arrayAt, textAt, dateAt } from './api-example.ts';
import { createCompanySiteSource, examplePages, hashedVacancy, htmlText, initToolkit, type SourceExtensionApi } from './toolkit.ts';

export function vkCursor(value: unknown): string | undefined {
  const raw = textAt(value); if (!raw) return undefined;
  try { return new URL(raw, 'https://team.vk.company').searchParams.get('offset') || raw; } catch { return undefined; }
}
export function vkSearchUrl(query: string, cursor?: string): string {
  const url = new URL('/career/api/v2/vacancies/', 'https://team.vk.company');
  url.searchParams.set('search', query); if (cursor) url.searchParams.set('offset', cursor); return url.href;
}
export function vkListingPage(payload: unknown): CompanyListingPage {
  const items = arrayAt(payload, 'results');
  return { listings: items.map((item) => ({ sourceId: textAt(item, 'id'),
    url: `https://team.vk.company/vacancy/${textAt(item, 'id')}`, title: textAt(item, 'title'),
    summary: textAt(item, 'description'), employer: 'VK', area: textAt(item, 'city'),
    experience: textAt(item, 'experience'), employment: textAt(item, 'employment'), workFormat: textAt(item, 'work_format'),
    keySkills: arrayAt(item, 'skills').map((skill) => textAt(skill, 'name')), publishedAt: dateAt(item, 'published_at') })),
    ...(vkCursor(textAt(payload, 'next')) ? { nextCursor: vkCursor(textAt(payload, 'next')) } : {}) };
}
export function vkVacancyText(html: string): { readonly title: string; readonly description: string } | null {
  const title = htmlText(/itemprop=["']title["'][^>]*>([\s\S]*?)<\//iu.exec(html)?.[1]
    ?? /<h1\b[^>]*>([\s\S]*?)<\/h1>/iu.exec(html)?.[1] ?? '');
  const description = htmlText(/itemprop=["']description["'][^>]*>([\s\S]*?)<\/[^>]+>/iu.exec(html)?.[1]
    ?? /<main\b[^>]*>([\s\S]*?)<\/main>/iu.exec(html)?.[1] ?? '');
  return title && description.length >= 20 ? { title, description } : null;
}
export function vkVacancyInput(candidate: VacancyCandidate, html: string, resolvedUrl: string,
  context: { readonly http: { safeVacancyUrl(source: string, input: string): string } }): VacancyInput | null {
  const detail = vkVacancyText(html); const listing = candidate.payload as CompanyListingPage['listings'][number] | undefined;
  if (!detail || !listing) return null;
  return hashedVacancy({ source: candidate.source, sourceId: candidate.sourceId, name: detail.title, employer: 'VK',
    area: listing.area || 'Не указано', salary: null, experience: listing.experience ? { kind: 'other', label: listing.experience } : { kind: 'unspecified' },
    employment: listing.employment ? 'other' : 'unspecified', schedule: 'unspecified',
    workFormat: /remote|удален/iu.test(listing.workFormat) ? 'remote' : 'unspecified', description: detail.description,
    keySkills: listing.keySkills, url: new URL(context.http.safeVacancyUrl('vk', resolvedUrl)),
    publishedAt: candidate.publishedAt, sourceQuery: candidate.searchName });
}
export const vkCompanySite: CompanySite = { id: 'vk', name: 'VK Team', employer: 'VK', hosts: ['team.vk.company'],
  queryLanguage: 'Russian or English', searchUrl: vkSearchUrl, listingPage: vkListingPage,
  vacancy: (_site, candidate, html, resolvedUrl, context) => vkVacancyInput(candidate, html, resolvedUrl, context) };
export function vkSource(options: { readonly maxPages?: number } = {}) { return createCompanySiteSource(vkCompanySite, options); }
export default function register(api: SourceExtensionApi): void { initToolkit(api); api.registerSourceProvider(vkSource({ maxPages: examplePages(api) })); }
