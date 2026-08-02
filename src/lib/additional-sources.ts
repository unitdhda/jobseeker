import { config } from '../config.ts';
import type { TextSearchProfile } from '../platforms/additional.ts';
import type { VacancyCandidate, VacancyInput } from './database.ts';
import { asObject, fetchSourceHtml, htmlText, jobPostings, plainText, structuredVacancy, type JsonObject } from './web-vacancy.ts';
import { trace } from './trace.ts';
import { errorMessage } from './logging.ts';
import { VacancySearchCollector } from './vacancy-search-collector.ts';

function pause(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 250 + Math.random() * 400));
}

export async function scrapeHabr(userId: string, profile: TextSearchProfile): Promise<{ seen: number; discovered: number }> {
  const collector = new VacancySearchCollector(userId, config.searchNewVacancyLimit);
  searches: for (const search of profile.searches) {
    for (let page = 1; page <= config.additionalMaxPages; page++) {
      const url = new URL('/vacancies', 'https://career.habr.com');
      url.searchParams.set('q', search.query);
      url.searchParams.set('type', 'all');
      if (page > 1) url.searchParams.set('page', String(page));
      try {
        trace('scrape.search.request', { platform: 'habr', search: search.name, query: search.query, page, url: url.toString() });
        const { html } = await fetchSourceHtml('habr', url.toString());
        let found = 0;
        for (const match of html.matchAll(/href=["'](\/vacancies\/\d+)(?:\?[^"']*)?["'][^>]*>([\s\S]*?)<\/a>/gi)) {
          const vacancyUrl = new URL(match[1], url).toString().split('?')[0];
          const sourceId = vacancyUrl.match(/\/vacancies\/(\d+)/)?.[1];
          if (sourceId) {
            found++;
            await collector.record({ source: 'habr', sourceId, url: vacancyUrl, searchName: search.name,
              title: htmlText(match[2]) || search.name, summary: search.name });
          }
          if (collector.complete) break;
        }
        trace('scrape.search.result', { platform: 'habr', search: search.name, page, found });
        if (collector.complete) break searches;
        if (!found) break;
        await pause();
      } catch (error) {
        console.error(`Failed to read Habr search ${search.name} page ${page}: ${errorMessage(error)}`);
        break;
      }
    }
  }
  return collector.result();
}

export async function scrapeRabota(userId: string, profile: TextSearchProfile): Promise<{ seen: number; discovered: number }> {
  const collector = new VacancySearchCollector(userId, config.searchNewVacancyLimit);
  searches: for (const search of profile.searches) {
    for (let page = 1; page <= config.additionalMaxPages; page++) {
      try {
        const url = new URL(`/vacancy/${encodeURIComponent(search.query)}/`, 'https://www.rabota.ru');
        if (page > 1) url.searchParams.set('page', String(page));
        trace('scrape.search.request', { platform: 'rabota', search: search.name, query: search.query, page, url: url.toString() });
        const { html } = await fetchSourceHtml('rabota', url.toString());
        const postings = jobPostings(html);
        trace('scrape.search.result', { platform: 'rabota', search: search.name, page, found: postings.length });
        for (const posting of postings) {
          const postingUrl = plainText(posting.url);
          const sourceId = postingUrl.match(/\/vacancy\/(\d+)/)?.[1] ?? plainText(asObject(posting.identifier)?.value);
          if (sourceId) await collector.record({ source: 'rabota', sourceId,
            url: postingUrl || `https://www.rabota.ru/vacancy/${sourceId}/`, searchName: search.name,
            title: plainText(posting.title) || search.name, summary: plainText(posting.description).slice(0, 1_000),
            publishedAt: plainText(posting.datePosted), payload: posting });
          if (collector.complete) break;
        }
        if (collector.complete) break searches;
        if (!postings.length) break;
        await pause();
      } catch (error) {
        console.error(`Failed to read Работа.ру search ${search.name} page ${page}: ${errorMessage(error)}`);
        break;
      }
    }
  }
  return collector.result();
}

export async function normalizeAdditionalCandidate(candidate: VacancyCandidate): Promise<VacancyInput | null> {
  if (candidate.source === 'habr') {
    const page = await fetchSourceHtml('habr', candidate.url);
    const posting = jobPostings(page.html)[0];
    if (!posting) throw new Error(`Habr vacancy ${candidate.sourceId} has no JobPosting JSON-LD`);
    return structuredVacancy('habr', candidate.sourceId, page.url, candidate.searchName, posting);
  }
  if (candidate.source === 'rabota') {
    return structuredVacancy('rabota', candidate.sourceId, candidate.url, candidate.searchName, candidate.payload as JsonObject);
  }
  throw new Error(`Unsupported vacancy source: ${candidate.source}`);
}
