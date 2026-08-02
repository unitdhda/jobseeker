import { createHash } from 'node:crypto';
import { config } from '../config.ts';
import { hireHiSearchUrl, type HireHiSearchProfile } from '../platforms/hirehi.ts';
import { type VacancyInput } from './database.ts';
import { trace } from './trace.ts';
import { VacancySearchCollector } from './vacancy-search-collector.ts';
import { fetchSourceText } from './safe-http.ts';
import { errorMessage } from './logging.ts';

const userAgent = 'JobseekerVacancyMonitor/1.0';
type JsonObject = Record<string, unknown>;

export interface HireHiListJob {
  id: number;
  category: string;
  title: string;
  company: string;
  created_at?: string;
  format?: string;
  level?: string;
  salary?: string;
  salary_display?: string;
}

interface HireHiListing {
  jobs?: HireHiListJob[];
  has_more?: boolean;
}

function pause(min = 250, max = 650): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));
}

async function fetchHtml(url: string): Promise<{ html: string; url: string }> {
  const response = await fetchSourceText('hirehi', url, {
    headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': userAgent },
    signal: AbortSignal.timeout(45_000),
  });
  if (response.contentType && !/text\/html|application\/xhtml\+xml/i.test(response.contentType)) {
    throw new Error('HireHi returned an unexpected content type');
  }
  return { html: response.text, url: response.url };
}

function jsonScript(html: string, id: string): unknown {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp(`<script\\b(?=[^>]*\\bid=["']${escaped}["'])[^>]*>([\\s\\S]*?)<\\/script>`, 'i'));
  if (!match) throw new Error(`HireHi page does not contain ${id} data`);
  return JSON.parse(match[1]);
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function findJobPosting(value: unknown): JsonObject | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findJobPosting(item);
      if (found) return found;
    }
    return null;
  }
  const object = asObject(value);
  if (!object) return null;
  if (object['@type'] === 'JobPosting') return object;
  return findJobPosting(object['@graph']);
}

function jobPosting(html: string): JsonObject {
  const scripts = [...html.matchAll(/<script\b(?=[^>]*\btype=["']application\/ld\+json["'])[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const script of scripts) {
    try {
      const posting = findJobPosting(JSON.parse(script[1]));
      if (posting) return posting;
    } catch {
      // Ignore unrelated malformed structured data and continue to the next block.
    }
  }
  throw new Error('HireHi vacancy page does not contain JobPosting JSON-LD');
}

function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(' · ');
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function postingLocation(posting: JsonObject): string {
  const locations = Array.isArray(posting.jobLocation) ? posting.jobLocation : [posting.jobLocation];
  for (const location of locations) {
    const address = asObject(asObject(location)?.address);
    const locality = text(address?.addressLocality);
    if (locality) return locality;
  }
  return '';
}

function parseSalary(value: string): Pick<VacancyInput, 'salaryFrom' | 'salaryTo' | 'salaryCurrency' | 'salaryGross'> {
  const normalized = value.replace(/\u00a0/g, ' ').trim();
  if (!normalized || /не указана/i.test(normalized)) {
    return { salaryFrom: null, salaryTo: null, salaryCurrency: null, salaryGross: null };
  }
  const amounts = [...normalized.matchAll(/\d[\d ]*/g)]
    .map((match) => Number(match[0].replace(/\s/g, ''))).filter(Number.isFinite);
  let salaryFrom: number | null = null;
  let salaryTo: number | null = null;
  if (amounts.length >= 2) [salaryFrom, salaryTo] = amounts;
  else if (/^\s*до\b/i.test(normalized)) salaryTo = amounts[0] ?? null;
  else salaryFrom = amounts[0] ?? null;
  const salaryCurrency = normalized.includes('₽') || /руб/i.test(normalized) ? 'RUR'
    : normalized.includes('$') ? 'USD' : normalized.includes('€') ? 'EUR' : null;
  return { salaryFrom, salaryTo, salaryCurrency, salaryGross: null };
}

function workFormat(value: string): string {
  const normalized = value.toLowerCase();
  return ['удалённо по рф', 'удалённо', 'гибрид', 'офис'].find((format) => normalized.startsWith(format)) ?? '';
}

function listingLocation(value: string): string {
  const format = workFormat(value);
  return format ? value.slice(format.length).trim() : '';
}

export async function normalizeHireHiCandidate(summary: HireHiListJob, sourceQuery: string): Promise<VacancyInput> {
  const requestedUrl = `https://hirehi.ru/${encodeURIComponent(summary.category)}/job-${summary.id}`;
  const { html, url } = await fetchHtml(requestedUrl);
  const posting = jobPosting(html);
  const detail = asObject(jsonScript(html, 'vacancy-data-json'));
  const sourceId = String(summary.id);
  const canonicalId = url.match(/-(\d+)\/?(?:\?.*)?$/)?.[1];
  if (canonicalId !== sourceId) throw new Error(`Unexpected HireHi vacancy URL: ${url}`);

  const name = text(posting.title) || summary.title;
  const employer = text(asObject(posting.hiringOrganization)?.name) || summary.company;
  const format = workFormat(summary.format ?? '');
  const area = text(detail?.location) || postingLocation(posting) || listingLocation(summary.format ?? '') || 'Не указано';
  const description = text(posting.description);
  if (!name || !employer || description.length < 20) throw new Error(`HireHi vacancy ${sourceId} is missing required content`);
  const skills = text(posting.skills).split(';').map((skill) => skill.trim())
    .filter((skill) => skill.length > 1 && !skill.endsWith('...')).slice(0, 30);
  const salary = parseSalary(summary.salary_display ?? summary.salary ?? '');
  const base = {
    source: 'hirehi', sourceId, name, employer, area, ...salary,
    experience: summary.level ?? '', employment: text(posting.employmentType),
    schedule: text(posting.workHours), workFormat: format, description, keySkills: skills,
    url, publishedAt: text(posting.datePosted) || summary.created_at || new Date().toISOString(), sourceQuery,
  };
  return { ...base, contentHash: createHash('sha256').update(JSON.stringify(base)).digest('hex') };
}

export async function scrapeHireHi(userId: string, profile: HireHiSearchProfile): Promise<{ seen: number; discovered: number }> {
  // HireHi disallows its search API in robots.txt. These are public SEO landing pages and vacancy pages instead.
  const collector = new VacancySearchCollector(userId, config.searchNewVacancyLimit);
  searches: for (const search of profile.searches) {
    for (let page = 1; page <= config.hireHiMaxPages; page++) {
      try {
        const url = hireHiSearchUrl(search, page);
        trace('scrape.search.request', { platform: 'hirehi', search: search.name, page, url });
        const { html } = await fetchHtml(url);
        const listing = jsonScript(html, '__SSR_JOBS__') as HireHiListing;
        const jobs = Array.isArray(listing.jobs) ? listing.jobs : [];
        trace('scrape.search.result', { platform: 'hirehi', search: search.name, page, found: jobs.length });
        for (const summary of jobs) {
          if (Number.isSafeInteger(summary.id)) {
            const sourceId = String(summary.id);
            await collector.record({ source: 'hirehi', sourceId,
              url: `https://hirehi.ru/${encodeURIComponent(summary.category)}/job-${summary.id}`,
              searchName: search.name, title: summary.title,
              summary: `${summary.company} ${summary.format ?? ''} ${summary.salary_display ?? ''}`,
              publishedAt: summary.created_at, payload: summary });
          }
          if (collector.complete) break;
        }
        if (collector.complete) break searches;
        if (!jobs.length || !listing.has_more) break;
        await pause();
      } catch (error) {
        console.error(`Failed to read HireHi search ${search.name} page ${page}: ${errorMessage(error)}`);
        break;
      }
    }
  }
  return collector.result();
}
