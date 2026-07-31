import { config } from '../config.ts';
import type { AvitoSearchProfile, GetmatchSearchProfile, TextSearchProfile } from '../platforms/additional.ts';
import { recordVacancyCandidate, type VacancyCandidate, type VacancyInput } from './database.ts';
import {
  asObject, fetchSourceHtml, hashedVacancy, htmlText, jobPostings, parseSalaryText,
  plainText, sourceUserAgent, structuredVacancy, type JsonObject,
} from './web-vacancy.ts';
import { trace } from './trace.ts';
import { fetchSourceJson } from './safe-http.ts';
import { errorMessage } from './logging.ts';

function pause(min = 250, max = 650): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));
}

type ScrapeResult = { seen: number; discovered: number };
const maximumGetmatchSitemapBytes = 8 * 1024 * 1024;

async function scrapeStructuredDetailPages(
  source: 'habr' | 'geekjob', userId: string, profile: TextSearchProfile,
  searchUrl: (query: string, page: number) => string, linkPattern: RegExp, idPattern: RegExp,
): Promise<ScrapeResult> {
  const links = new Map<string, { url: string; searchName: string; title: string }>();
  for (const search of profile.searches) {
    for (let page = 1; page <= config.additionalMaxPages; page++) {
      try {
        const url = searchUrl(search.query, page);
        trace('scrape.search.request', { platform: source, search: search.name, query: search.query, page, url });
        const { html } = await fetchSourceHtml(source, url);
        let found = 0;
        for (const match of html.matchAll(linkPattern)) {
          const url = new URL(match[1], searchUrl(search.query, page)).toString().split('?')[0];
          const id = url.match(idPattern)?.[1];
          if (id && !links.has(id)) links.set(id, { url, searchName: search.name, title: htmlText(match[2] ?? '') || search.name });
          if (id) found++;
        }
        trace('scrape.search.result', { platform: source, search: search.name, page, found });
        await pause();
      } catch (error) {
        console.error(`Failed to read ${source} search ${search.name} page ${page}: ${errorMessage(error)}`);
        break;
      }
    }
  }

  let discovered = 0;
  for (const [sourceId, link] of links) {
    if (recordVacancyCandidate(userId, { source, sourceId, url: link.url, searchName: link.searchName,
      title: link.title, summary: link.searchName })) discovered++;
  }
  return { seen: links.size, discovered };
}

export function scrapeHabr(userId: string, profile: TextSearchProfile): Promise<ScrapeResult> {
  return scrapeStructuredDetailPages('habr', userId, profile, (query, page) => {
    const url = new URL('/vacancies', 'https://career.habr.com');
    url.searchParams.set('q', query); url.searchParams.set('type', 'all');
    if (page > 1) url.searchParams.set('page', String(page));
    return url.toString();
  }, /href=["'](\/vacancies\/\d+)(?:\?[^"']*)?["'][^>]*>([\s\S]*?)<\/a>/gi, /\/vacancies\/(\d+)/);
}

export async function scrapeGeekJob(userId: string, profile: TextSearchProfile): Promise<ScrapeResult> {
  // GeekJob's documented qs form currently returns empty pages, so filter its public listing locally by title.
  const links = new Map<string, { url: string; searchName: string }>();
  for (let page = 1; page <= config.additionalMaxPages; page++) {
    const url = new URL('/vacancies', 'https://geekjob.ru');
    if (page > 1) url.searchParams.set('page', String(page));
    try {
      trace('scrape.search.request', { platform: 'geekjob', page, url: url.toString(), localQueries: profile.searches.map((search) => search.query) });
      const { html } = await fetchSourceHtml('geekjob', url.toString());
      let found = 0;
      for (const match of html.matchAll(/<a\b[^>]*href=["'](\/vacancy\/([a-f0-9]+))[^"']*["'][^>]*class=["'][^"']*\btitle\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)) {
        const title = htmlText(match[3]).toLowerCase();
        const search = profile.searches.find((candidate) => candidate.query.toLowerCase().split(/\s+/)
          .filter((term) => term.length > 2 && !['developer','разработчик','engineer'].includes(term))
          .some((term) => title.includes(term)));
        if (search && !links.has(match[2])) links.set(match[2], {
          url: new URL(match[1], 'https://geekjob.ru').toString(), searchName: search.name,
        });
        if (search) found++;
      }
      trace('scrape.search.result', { platform: 'geekjob', page, found });
      await pause();
    } catch (error) {
      console.error(`Failed to read GeekJob page ${page}: ${errorMessage(error)}`);
      break;
    }
  }
  let discovered = 0;
  for (const [sourceId, link] of links) {
    if (recordVacancyCandidate(userId, { source: 'geekjob', sourceId, url: link.url, searchName: link.searchName,
      title: link.searchName, summary: link.searchName })) discovered++;
  }
  return { seen: links.size, discovered };
}

function classSection(html: string, className: string, tag = '[a-z0-9]+'): string {
  const match = html.match(new RegExp(`<(${tag})\\b[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/\\1>`, 'i'));
  return match?.[2] ?? '';
}

function getmatchDate(html: string): string {
  const date = html.match(/Дата публикации:\s*(\d{2})\.(\d{2})\.(\d{4})/i);
  return date ? new Date(`${date[3]}-${date[2]}-${date[1]}T00:00:00+03:00`).toISOString() : new Date().toISOString();
}

function getmatchVacancy(sourceId: string, url: string, sourceQuery: string, html: string): VacancyInput | null {
  if (/b-notification_danger/i.test(html) && /archived|больше не ищет/i.test(html)) return null;
  const header = classSection(html, 'b-vacancy-header', 'section');
  const name = htmlText(header.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? '');
  const employer = htmlText(header.match(/<h2[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? '') || 'Не указано';
  const salaryText = htmlText(header.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)?.[1] ?? '');
  const location = htmlText(classSection(html, 'b-location', 'section')) || 'Не указано';
  const specs = htmlText(classSection(html, 'b-specs', 'div'));
  const description = htmlText(classSection(html, 'b-vacancy-description', 'section'));
  if (!name || description.length < 20) throw new Error(`getmatch vacancy ${sourceId} is missing required content`);
  const skills = [...html.matchAll(/class=["'][^"']*tag_title[^"']*["'][^>]*>([^<]+)</gi)]
    .map((match) => htmlText(match[1])).filter(Boolean).slice(0, 30);
  const salary = parseSalaryText(salaryText);
  return hashedVacancy({
    source: 'getmatch', sourceId, name, employer, area: location, ...salary,
    experience: specs, employment: '', schedule: '', workFormat: /remote|удал/i.test(location) ? 'remote' : '',
    description, keySkills: skills, url, publishedAt: getmatchDate(html), sourceQuery,
  });
}

export async function scrapeGetmatch(userId: string, profile: GetmatchSearchProfile): Promise<ScrapeResult> {
  trace('scrape.search.request', { platform: 'getmatch', url: 'https://getmatch.ru/sitemap.xml', queries: profile.searches.map((search) => search.query) });
  const { html: sitemap } = await fetchSourceHtml('getmatch', 'https://getmatch.ru/sitemap.xml', maximumGetmatchSitemapBytes);
  const links = new Map<string, { url: string; lastmod: string; searchName: string }>();
  for (const entry of sitemap.matchAll(/<url>([\s\S]*?)<\/url>/gi)) {
    const url = entry[1].match(/<loc>(https:\/\/getmatch\.ru\/vacancies\/(\d+)-([^<]+))<\/loc>/i);
    if (!url) continue;
    const slug = `-${url[3].toLowerCase()}-`;
    const matching = profile.searches.find((search) => slug.includes(`-${search.query.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-`));
    if (!matching) continue;
    links.set(url[2], {
      url: url[1], lastmod: entry[1].match(/<lastmod>([^<]+)<\/lastmod>/i)?.[1] ?? '', searchName: matching.name,
    });
  }
  trace('scrape.search.result', { platform: 'getmatch', matched: links.size });
  const candidates = [...links.entries()].sort((a, b) => b[1].lastmod.localeCompare(a[1].lastmod))
    .slice(0, config.getmatchMaxCandidates);
  let discovered = 0;
  for (const [sourceId, link] of candidates) {
    const title = new URL(link.url).pathname.split('/').pop()?.replace(/^\d+-/, '').replaceAll('-', ' ') ?? link.searchName;
    if (recordVacancyCandidate(userId, { source: 'getmatch', sourceId, url: link.url, searchName: link.searchName,
      title, summary: link.searchName, publishedAt: link.lastmod })) discovered++;
  }
  return { seen: links.size, discovered };
}

export async function scrapeRabota(userId: string, profile: TextSearchProfile): Promise<ScrapeResult> {
  const postings = new Map<string, { posting: JsonObject; searchName: string }>();
  for (const search of profile.searches) {
    for (let page = 1; page <= config.additionalMaxPages; page++) {
      try {
        const url = new URL(`/vacancy/${encodeURIComponent(search.query)}/`, 'https://www.rabota.ru');
        if (page > 1) url.searchParams.set('page', String(page));
        trace('scrape.search.request', { platform: 'rabota', search: search.name, query: search.query, page, url: url.toString() });
        const result = await fetchSourceHtml('rabota', url.toString());
        const pagePostings = jobPostings(result.html);
        trace('scrape.search.result', { platform: 'rabota', search: search.name, page, found: pagePostings.length });
        for (const posting of pagePostings) {
          const postingUrl = plainText(posting.url);
          const id = postingUrl.match(/\/vacancy\/(\d+)/)?.[1]
            ?? plainText(asObject(posting.identifier)?.value);
          if (id && !postings.has(id)) postings.set(id, { posting, searchName: search.name });
        }
        await pause();
      } catch (error) {
        console.error(`Failed to read Работа.ру search ${search.name} page ${page}: ${errorMessage(error)}`);
        break;
      }
    }
  }
  let discovered = 0;
  for (const [sourceId, item] of postings) {
    const url = plainText(item.posting.url) || `https://www.rabota.ru/vacancy/${sourceId}/`;
    if (recordVacancyCandidate(userId, { source: 'rabota', sourceId, url, searchName: item.searchName,
      title: plainText(item.posting.title) || item.searchName, summary: plainText(item.posting.description).slice(0, 1_000),
      publishedAt: plainText(item.posting.datePosted), payload: item.posting })) discovered++;
  }
  return { seen: postings.size, discovered };
}

function avitoSlug(value: string): string {
  const map: Record<string, string> = { 'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'e','ж':'zh','з':'z','и':'i','й':'j','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f','х':'h','ц':'c','ч':'ch','ш':'sh','щ':'sch','ы':'y','э':'e','ю':'ju','я':'ja','ь':'','ъ':'' };
  return value.toLowerCase().split('').map((char) => map[char] ?? char).join('').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function avitoItems(value: unknown, result: JsonObject[] = []): JsonObject[] {
  if (Array.isArray(value)) for (const item of value) avitoItems(item, result);
  else {
    const object = asObject(value);
    if (object) {
      if (object.type === 'item' && object.categoryId === 111 && object.id) result.push(object);
      else for (const nested of Object.values(object)) avitoItems(nested, result);
    }
  }
  return result;
}

function avitoStep(item: JsonObject, step: string, component?: string): JsonObject | null {
  const values = asObject(item.iva)?.[step];
  if (!Array.isArray(values)) return null;
  for (const value of values) {
    const object = asObject(value);
    if (!object) continue;
    if (!component || asObject(object.componentData)?.component === component) return asObject(object.payload);
  }
  return null;
}

function avitoVacancy(item: JsonObject, sourceQuery: string): VacancyInput {
  const sourceId = String(item.id);
  const description = plainText(avitoStep(item, 'DescriptionStep', 'description')?.description);
  const params = plainText(avitoStep(item, 'ParamsStep', 'params')?.text);
  const employer = plainText(asObject(avitoStep(item, 'UserInfoStep', 'seller-info')?.profile)?.title)
    || plainText(avitoStep(item, 'FourthLineStep', 'link')?.value) || 'Не указано';
  const path = plainText(item.urlPath).split('?')[0];
  const price = plainText(asObject(item.priceDetailed)?.fullString);
  const salary = parseSalaryText(price);
  const published = Number(item.sortTimeStamp);
  return hashedVacancy({
    source: 'avito', sourceId, name: plainText(item.title), employer,
    area: plainText(asObject(item.location)?.name) || plainText(asObject(item.addressDetailed)?.locationName) || 'Не указано',
    ...salary, experience: params, employment: params, schedule: params,
    workFormat: /удал|remote/i.test(params) ? 'remote' : '', description, keySkills: [],
    url: new URL(path, 'https://www.avito.ru').toString(),
    publishedAt: Number.isFinite(published) ? new Date(published).toISOString() : new Date().toISOString(), sourceQuery,
  });
}

export async function scrapeAvito(userId: string, profile: AvitoSearchProfile): Promise<ScrapeResult> {
  const items = new Map<string, { item: JsonObject; searchName: string }>();
  for (const search of profile.searches) {
    for (let page = 1; page <= config.additionalMaxPages; page++) {
      try {
        const path = search.query === 'информационные технологии'
          ? `/${config.avitoRegion}/vakansii/informacionnye_texnologii-ASgBAgICAUSOC~CXkAM`
          : `/${config.avitoRegion}/vakansii/tag/${avitoSlug(search.query)}`;
        const url = new URL(path, 'https://www.avito.ru');
        if (page > 1) url.searchParams.set('p', String(page));
        trace('scrape.search.request', { platform: 'avito', search: search.name, query: search.query, page, url: url.toString() });
        const { html } = await fetchSourceHtml('avito', url.toString());
        const state = html.match(/<script\b[^>]*data-mfe-state=["']true["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
        if (!state) throw new Error('Avito page has no public listing state');
        const pageItems = avitoItems(JSON.parse(state));
        trace('scrape.search.result', { platform: 'avito', search: search.name, page, found: pageItems.length });
        for (const item of pageItems) {
          const id = String(item.id);
          if (!items.has(id)) items.set(id, { item, searchName: search.name });
        }
        await pause(500, 1_000);
      } catch (error) {
        console.error(`Failed to read Avito search ${search.name} page ${page}: ${errorMessage(error)}`);
        break;
      }
    }
  }
  let discovered = 0;
  for (const [sourceId, entry] of items) {
    const title = plainText(entry.item.title);
    const summary = `${plainText(avitoStep(entry.item, 'DescriptionStep', 'description')?.description)} ${plainText(avitoStep(entry.item, 'ParamsStep', 'params')?.text)}`.slice(0, 1_000);
    if (recordVacancyCandidate(userId, { source: 'avito', sourceId,
      url: new URL(plainText(entry.item.urlPath).split('?')[0], 'https://www.avito.ru').toString(),
      searchName: entry.searchName, title, summary, payload: entry.item })) discovered++;
  }
  return { seen: items.size, discovered };
}

export async function scrapeSuperJob(userId: string, profile: TextSearchProfile): Promise<ScrapeResult> {
  if (!config.superJobApiKey) throw new Error('SUPERJOB_API_KEY is required to enable the SuperJob source');
  const objects = new Map<string, { vacancy: JsonObject; searchName: string }>();
  for (const search of profile.searches) {
    for (let page = 0; page < config.additionalMaxPages; page++) {
      const url = new URL('/2.0/vacancies/', 'https://api.superjob.ru');
      url.searchParams.set('keyword', search.query); url.searchParams.set('town', String(config.superJobTownId));
      url.searchParams.set('count', '100'); url.searchParams.set('page', String(page));
      trace('scrape.search.request', { platform: 'superjob', search: search.name, query: search.query, page: page + 1, url: url.toString() });
      const data = asObject(await fetchSourceJson('superjob', url.toString(), {
        headers: { 'X-Api-App-Id': config.superJobApiKey, 'user-agent': sourceUserAgent },
        signal: AbortSignal.timeout(45_000),
      }));
      const pageObjects = Array.isArray(data?.objects) ? data.objects : [];
      trace('scrape.search.result', { platform: 'superjob', search: search.name, page: page + 1, found: pageObjects.length });
      for (const vacancy of pageObjects) {
        const object = asObject(vacancy); const id = object ? plainText(object.id) : '';
        if (object && id && !objects.has(id)) objects.set(id, { vacancy: object, searchName: search.name });
      }
    }
  }
  let discovered = 0;
  for (const [sourceId, entry] of objects) {
    const vacancy = entry.vacancy;
    const published = Number(vacancy.date_published);
    if (recordVacancyCandidate(userId, { source: 'superjob', sourceId, url: plainText(vacancy.link), searchName: entry.searchName,
      title: plainText(vacancy.profession), summary: htmlText(plainText(vacancy.candidat)).slice(0, 1_000),
      publishedAt: Number.isFinite(published) ? new Date(published * 1_000).toISOString() : undefined,
      payload: vacancy })) discovered++;
  }
  return { seen: objects.size, discovered };
}

export async function normalizeAdditionalCandidate(candidate: VacancyCandidate): Promise<VacancyInput | null> {
  if (candidate.source === 'habr' || candidate.source === 'geekjob') {
    const page = await fetchSourceHtml(candidate.source, candidate.url);
    const posting = jobPostings(page.html)[0];
    if (!posting) throw new Error(`${candidate.source} vacancy ${candidate.sourceId} has no JobPosting JSON-LD`);
    return structuredVacancy(candidate.source, candidate.sourceId, page.url, candidate.searchName, posting);
  }
  if (candidate.source === 'getmatch') {
    const page = await fetchSourceHtml('getmatch', candidate.url);
    return getmatchVacancy(candidate.sourceId, page.url, candidate.searchName, page.html);
  }
  if (candidate.source === 'rabota') {
    return structuredVacancy('rabota', candidate.sourceId, candidate.url, candidate.searchName, candidate.payload as JsonObject);
  }
  if (candidate.source === 'avito') {
    const vacancy = avitoVacancy(candidate.payload as JsonObject, candidate.searchName);
    return vacancy.description.length >= 20 ? vacancy : null;
  }
  if (candidate.source === 'superjob') {
    const vacancy = candidate.payload as JsonObject;
    const salaryFrom = Number(vacancy.payment_from); const salaryTo = Number(vacancy.payment_to);
    const published = Number(vacancy.date_published);
    const normalized = hashedVacancy({
      source: 'superjob', sourceId: candidate.sourceId, name: plainText(vacancy.profession),
      employer: plainText(vacancy.firm_name) || 'Не указано', area: plainText(asObject(vacancy.town)?.title) || 'Не указано',
      salaryFrom: salaryFrom > 0 ? salaryFrom : null, salaryTo: salaryTo > 0 ? salaryTo : null,
      salaryCurrency: plainText(vacancy.currency).toUpperCase().replace('RUB', 'RUR') || null, salaryGross: null,
      experience: plainText(asObject(vacancy.experience)?.title), employment: plainText(asObject(vacancy.type_of_work)?.title),
      schedule: plainText(asObject(vacancy.place_of_work)?.title), workFormat: plainText(asObject(vacancy.place_of_work)?.title),
      description: htmlText(plainText(vacancy.candidat)), keySkills: [], url: plainText(vacancy.link),
      publishedAt: Number.isFinite(published) ? new Date(published * 1_000).toISOString() : new Date().toISOString(),
      sourceQuery: candidate.searchName,
    });
    return normalized.description.length >= 20 ? normalized : null;
  }
  throw new Error(`Unsupported queued source: ${candidate.source}`);
}
