import { createHash } from 'node:crypto';
import type { VacancyInput } from './database.ts';
import { fetchSourceText } from './safe-http.ts';

export type JsonObject = Record<string, unknown>;
export const sourceUserAgent = 'JobseekerVacancyMonitor/1.0';

export async function fetchSourceHtml(source: string, url: string): Promise<{ html: string; url: string }> {
  const response = await fetchSourceText(source, url, {
    headers: { accept: 'text/html,application/xhtml+xml,application/xml,text/xml', 'user-agent': sourceUserAgent },
    signal: AbortSignal.timeout(45_000),
  });
  if (response.contentType && !/(?:text\/(?:html|xml)|application\/(?:xhtml\+xml|xml))\b/i.test(response.contentType)) {
    throw new Error(`${source} returned an unexpected content type`);
  }
  return { html: response.text, url: response.url };
}

export function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

export function plainText(value: unknown): string {
  if (Array.isArray(value)) return value.map(plainText).filter(Boolean).join(' · ');
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

export function htmlText(value: string): string {
  return value
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/?(?:p|div|section|article|h[1-6]|li|ul|ol|br|tr|table)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replaceAll('&nbsp;', ' ').replaceAll('&amp;', '&').replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>')
    .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function findPosting(value: unknown): JsonObject[] {
  if (Array.isArray(value)) return value.flatMap(findPosting);
  const object = asObject(value);
  if (!object) return [];
  if (object['@type'] === 'JobPosting') return [object];
  return findPosting(object['@graph']);
}

export function jobPostings(html: string): JsonObject[] {
  const postings: JsonObject[] = [];
  for (const script of html.matchAll(/<script\b(?=[^>]*\btype=["']application\/ld\+json["'])[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { postings.push(...findPosting(JSON.parse(script[1]))); } catch { /* unrelated malformed JSON-LD */ }
  }
  return postings;
}

export function parseSalaryText(value: string): Pick<VacancyInput, 'salaryFrom' | 'salaryTo' | 'salaryCurrency' | 'salaryGross'> {
  const normalized = htmlText(value).replace(/\u00a0/g, ' ').trim();
  if (!normalized || /не указан|по договор|agreement/i.test(normalized)) {
    return { salaryFrom: null, salaryTo: null, salaryCurrency: null, salaryGross: null };
  }
  const amounts = [...normalized.matchAll(/\d[\d ]*/g)]
    .map((match) => Number(match[0].replace(/\s/g, ''))).filter(Number.isFinite);
  let salaryFrom: number | null = null;
  let salaryTo: number | null = null;
  if (amounts.length >= 2) [salaryFrom, salaryTo] = amounts;
  else if (/^\s*(?:до|to)\b/i.test(normalized)) salaryTo = amounts[0] ?? null;
  else salaryFrom = amounts[0] ?? null;
  const salaryCurrency = normalized.includes('₽') || /руб|RUB/i.test(normalized) ? 'RUR'
    : normalized.includes('$') || /USD/i.test(normalized) ? 'USD'
    : normalized.includes('€') || /EUR/i.test(normalized) ? 'EUR' : null;
  const salaryGross = /на руки|\bnet\b/i.test(normalized) ? false : /до вычета|\bgross\b/i.test(normalized) ? true : null;
  return { salaryFrom, salaryTo, salaryCurrency, salaryGross };
}

function structuredSalary(posting: JsonObject): Pick<VacancyInput, 'salaryFrom' | 'salaryTo' | 'salaryCurrency' | 'salaryGross'> {
  const salary = asObject(posting.baseSalary) ?? asObject(posting.estimatedSalary);
  const value = asObject(salary?.value);
  if (!salary || !value) return parseSalaryText(plainText(posting.baseSalary));
  const exact = Number(value.value);
  const from = Number(value.minValue);
  const to = Number(value.maxValue);
  const currency = plainText(salary.currency).toUpperCase().replace('RUB', 'RUR') || null;
  return {
    salaryFrom: Number.isFinite(from) ? from : Number.isFinite(exact) ? exact : null,
    salaryTo: Number.isFinite(to) ? to : null,
    salaryCurrency: currency,
    salaryGross: null,
  };
}

function structuredLocation(posting: JsonObject): string {
  const locations = Array.isArray(posting.jobLocation) ? posting.jobLocation : [posting.jobLocation];
  for (const location of locations) {
    const address = asObject(asObject(location)?.address);
    const result = plainText(address?.addressLocality) || plainText(address?.addressRegion)
      || plainText(address?.streetAddress) || plainText(asObject(location)?.name);
    if (result) return result;
  }
  return plainText(posting.applicantLocationRequirements) || 'Не указано';
}

export function structuredVacancy(
  source: string, sourceId: string, sourceUrl: string, sourceQuery: string, posting: JsonObject,
): VacancyInput {
  const name = plainText(posting.title);
  const employer = plainText(asObject(posting.hiringOrganization)?.name) || 'Не указано';
  const description = htmlText(plainText(posting.description));
  if (!name || description.length < 20) throw new Error(`${source} vacancy ${sourceId} is missing required content`);
  const experienceObject = asObject(posting.experienceRequirements);
  const months = Number(experienceObject?.monthsOfExperience);
  const experience = plainText(experienceObject?.description) || plainText(posting.qualifications)
    || (Number.isFinite(months) ? `${months} months` : '');
  const skills = plainText(posting.skills).split(/[;,]/).map((skill) => skill.trim()).filter(Boolean).slice(0, 30);
  const remote = plainText(posting.jobLocationType).toUpperCase().includes('TELECOMMUTE');
  const salary = structuredSalary(posting);
  const base = {
    source, sourceId, name, employer, area: structuredLocation(posting), ...salary,
    experience, employment: plainText(posting.employmentType), schedule: plainText(posting.workHours),
    workFormat: remote ? 'remote' : '', description, keySkills: skills,
    url: sourceUrl, publishedAt: plainText(posting.datePosted) || new Date().toISOString(), sourceQuery,
  };
  return { ...base, contentHash: createHash('sha256').update(JSON.stringify(base)).digest('hex') };
}

export function hashedVacancy(base: Omit<VacancyInput, 'contentHash'>): VacancyInput {
  return { ...base, contentHash: createHash('sha256').update(JSON.stringify(base)).digest('hex') };
}
