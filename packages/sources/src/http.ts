import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

// Populated by the registry from each platform's own hosts declaration: adding a source no longer means editing
// this file, and a host absent from an adapter's declaration still fails closed here.
const sourceHosts = new Map<string, ReadonlySet<string>>();
export function registerSourceHosts(source: string, hosts: readonly string[]): void {
  sourceHosts.set(source, new Set(hosts));
}

function privateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
}

function privateIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0];
  return normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd')
    || /^fe[89ab]/.test(normalized) || normalized.startsWith('ff')
    || normalized.startsWith('::ffff:127.') || normalized.startsWith('::ffff:10.')
    || normalized.startsWith('::ffff:192.168.');
}

export function sourceUrl(source: string, input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error(`Invalid ${source} URL`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new Error(`Unsafe ${source} URL`);
  }
  const allowed = sourceHosts.get(source);
  if (!allowed?.has(url.hostname.toLowerCase())) throw new Error(`Unexpected ${source} URL host`);
  return url;
}

export function safeVacancyUrl(source: string, input: string): string {
  return sourceUrl(source, input).toString();
}

export async function assertPublicAddress(url: URL): Promise<void> {
  if (isIP(url.hostname)) throw new Error('Source URL must use an approved DNS hostname');
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address, family }) => family === 4 ? privateIpv4(address) : privateIpv6(address))) {
    throw new Error(`Source host ${url.hostname} resolved to a non-public address`);
  }
}


export const maximumSourceBytes = 5 * 1024 * 1024;
const maximumRedirects = 3;

export async function readResponseBytes(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error(`Response exceeds ${maximumBytes} bytes`);
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel('response too large');
        throw new Error(`Response exceeds ${maximumBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

export async function fetchSourceResponse(source: string, input: string, init: RequestInit = {}): Promise<Response> {
  let current = sourceUrl(source, input);
  for (let redirects = 0; ; redirects++) {
    await assertPublicAddress(current);
    const response = await fetch(current, { ...init, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (redirects >= maximumRedirects) { await response.body?.cancel(); throw new Error('Too many source redirects'); }
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new Error('Source redirect has no location');
    const next = sourceUrl(source, new URL(location, current).toString());
    if (next.origin !== current.origin) throw new Error('Cross-origin source redirect was blocked');
    current = next;
  }
}

export async function fetchSourceText(source: string, input: string, init: RequestInit = {},
  maximumBytes = maximumSourceBytes): Promise<{ text: string; url: string; contentType: string }> {
  const response = await fetchSourceResponse(source, input, init);
  if (!response.ok) throw new Error(`Source request failed (${response.status})`);
  const contentType = response.headers.get('content-type') ?? '';
  const bytes = await readResponseBytes(response, maximumBytes);
  return { text: new TextDecoder().decode(bytes), url: response.url, contentType };
}

export async function fetchSourceJson(source: string, input: string, init: RequestInit = {},
  maximumBytes = maximumSourceBytes): Promise<unknown> {
  const result = await fetchSourceText(source, input, init, maximumBytes);
  if (result.contentType && !/(?:application|text)\/(?:[a-z0-9.+-]*\+)?json\b/i.test(result.contentType)) {
    throw new Error('Source returned an unexpected content type');
  }
  return JSON.parse(result.text);
}

import { createHash } from 'node:crypto';
import type { VacancyInput } from '@jobseeker/store';

export type JsonObject = Record<string, unknown>;
export const sourceUserAgent = 'JobseekerVacancyMonitor/1.0';

export async function fetchSourceHtml(source: string, url: string,
  maximumBytes?: number): Promise<{ html: string; url: string }> {
  const response = await fetchSourceText(source, url, {
    headers: { accept: 'text/html,application/xhtml+xml,application/xml,text/xml', 'user-agent': sourceUserAgent },
    signal: AbortSignal.timeout(45_000),
  }, maximumBytes);
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

const russianMonths = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/**
 * A Russian listing date such as "3 августа" or "29 июля 2026", which several boards print instead of a machine
 * readable attribute. Without a year the most recent occurrence is meant, so a date that would land in the future
 * belongs to the previous year. Returns null on anything it cannot read, so a caller never invents a date.
 */
export function russianDate(text: string, now = new Date()): string | null {
  const match = /(\d{1,2})\s+(\p{L}+)(?:\s+(\d{4}))?/u.exec(text);
  if (!match) return null;
  const month = russianMonths.indexOf(match[2]!.toLowerCase());
  if (month < 0) return null;
  const year = match[3] ? Number(match[3]) : now.getUTCFullYear();
  const parsed = new Date(Date.UTC(year, month, Number(match[1])));
  if (!match[3] && parsed.getTime() > now.getTime() + 86_400_000) parsed.setUTCFullYear(year - 1);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
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

import { recordVacancyCandidate, type VacancyCandidateInput } from '@jobseeker/store';
import type { SearchRecipient } from './contract.ts';

export interface VacancySearchResult { seen: number; discovered: number }

/**
 * Records unique search results until the per-platform new-vacancy target is reached.
 *
 * One collector spans a whole platform plan, because a listing found by two clustered searches is one fetch and
 * should count once. Each listing is written for every user the search was planned for, under that user's own
 * search name, so the per-user candidate prefilter keeps scoring against the query that user actually asked for.
 * `recordVacancyCandidate` reports newness against the shared store, so only the first recipient of a listing can
 * make it count towards the limit.
 */
export class VacancySearchCollector {
  readonly #seen = new Set<string>();
  #discovered = 0;

  constructor(readonly newVacancyLimit: number) {}

  get complete(): boolean { return this.#discovered >= this.newVacancyLimit; }

  async record(input: VacancyCandidateInput, recipients: readonly SearchRecipient[]): Promise<boolean> {
    const key = `${input.source}:${input.sourceId}`;
    if (this.complete || this.#seen.has(key)) return false;
    this.#seen.add(key);
    let fresh = false;
    for (const recipient of recipients) {
      if (await recordVacancyCandidate(recipient.userId, { ...input, searchName: recipient.searchName })) fresh = true;
    }
    if (fresh) this.#discovered++;
    return true;
  }

  result(): VacancySearchResult {
    return { seen: this.#seen.size, discovered: this.#discovered };
  }
}
