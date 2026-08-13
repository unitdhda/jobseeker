import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import {
  parseCurrencyCode,
  parseSourceKey,
  parseSourceVacancyId,
  parseVacancyContentHash,
  type EmploymentType,
  type ExperienceRequirement,
  type SalaryRange,
  type SearchRecipient,
  type VacancyCandidateInput,
  type VacancyInput,
  type WorkFormat,
  type WorkSchedule,
} from '@jobseeker/engine/contracts';

export interface SourceHostDeclaration { readonly id: string; readonly hosts: readonly string[] }
export interface SourceUrlPolicy {
  sourceUrl(source: string, input: string): URL;
  safeVacancyUrl(source: string, input: string): string;
}
export interface SourceHttp extends SourceUrlPolicy {
  fetchSourceResponse(source: string, input: string, init?: RequestInit): Promise<Response>;
  fetchSourceText(source: string, input: string, init?: RequestInit, maximumBytes?: number):
    Promise<{ readonly text: string; readonly url: string; readonly contentType: string }>;
  fetchSourceJson(source: string, input: string, init?: RequestInit, maximumBytes?: number): Promise<unknown>;
  fetchSourceHtml(source: string, input: string, maximumBytes?: number):
    Promise<{ readonly html: string; readonly url: string }>;
}

function canonicalHost(value: string): string {
  if (typeof value !== 'string' || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(value)
    || value.includes('..')) throw new TypeError('Invalid source host declaration.');
  const parsed = new URL(`https://${value}`);
  if (parsed.hostname !== value) throw new TypeError('Invalid source host declaration.');
  return value;
}

function hasExplicitPort(input: string): boolean {
  const authority = /^https:\/\/([^/?#]*)/iu.exec(input)?.[1] ?? '';
  const hostPart = authority.slice(authority.lastIndexOf('@') + 1);
  return /:\d+$/u.test(hostPart);
}

/** The trusted declaration closure only grows, retaining URL policy for persisted candidates after replacement. */
export function createSourceUrlPolicy(providers: Iterable<SourceHostDeclaration> = []):
SourceUrlPolicy & { addProvider(provider: SourceHostDeclaration): void } {
  const sourceHosts = new Map<string, Set<string>>();
  const addProvider = (provider: SourceHostDeclaration): void => {
    const id = parseSourceKey(provider.id);
    const hosts = sourceHosts.get(id) ?? new Set<string>();
    for (const host of provider.hosts) hosts.add(canonicalHost(host));
    sourceHosts.set(id, hosts);
  };
  for (const provider of providers) addProvider(provider);
  const sourceUrl = (source: string, input: string): URL => {
    const hosts = sourceHosts.get(source);
    if (!hosts) throw new Error(`Unknown source URL policy: ${source}.`);
    let url: URL;
    try { url = new URL(input); } catch { throw new TypeError(`Invalid ${source} URL.`); }
    if (url.protocol !== 'https:' || url.username || url.password || hasExplicitPort(input)
      || !hosts.has(url.hostname)) throw new TypeError(`Unsafe ${source} URL.`);
    return url;
  };
  return Object.freeze({
    addProvider,
    sourceUrl,
    safeVacancyUrl: (source: string, input: string) => sourceUrl(source, input).href,
  });
}

export function isPublicIpAddress(address: string): boolean {
  try {
    // process() converts IPv4-mapped IPv6 before classification, preventing mapped-private bypasses.
    return ipaddr.process(address).range() === 'unicast';
  } catch {
    return false;
  }
}

export interface SourceHttpDependencies {
  lookup(hostname: string): Promise<readonly { readonly address: string }[]>;
  fetch(input: string, init: RequestInit): Promise<Response>;
}

const defaultDependencies: SourceHttpDependencies = {
  lookup: async (hostname) => lookup(hostname, { all: true, verbatim: true }),
  fetch: (input, init) => fetch(input, init),
};

export async function assertPublicAddress(
  url: URL,
  resolve: SourceHttpDependencies['lookup'] = defaultDependencies.lookup,
): Promise<void> {
  if (isIP(url.hostname)) throw new TypeError('Unsafe source destination: IP literals are forbidden.');
  const addresses = await resolve(url.hostname);
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicIpAddress(address))) {
    throw new TypeError('Unsafe source destination: DNS did not resolve exclusively to public unicast addresses.');
  }
}

export const maximumSourceBytes = 5 * 1024 * 1024;
export const sourceUserAgent = 'JobseekerVacancyMonitor/1.0';
const maximumRedirects = 3;
const defaultTimeoutMilliseconds = 30_000;

function byteLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Invalid source response byte limit.');
}

export async function readResponseBytes(response: Response, maximumBytes: number): Promise<Uint8Array> {
  byteLimit(maximumBytes);
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximumBytes)) {
    throw new RangeError('Source response exceeds the allowed byte limit.');
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new RangeError('Source response exceeds the allowed byte limit.');
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

function headersWithDefaults(input: HeadersInit | undefined): Headers {
  const headers = new Headers(input);
  if (!headers.has('user-agent')) headers.set('user-agent', sourceUserAgent);
  return headers;
}

export async function fetchSourceResponse(
  policy: SourceUrlPolicy,
  source: string,
  input: string,
  init: RequestInit = {},
  dependencies: SourceHttpDependencies = defaultDependencies,
): Promise<Response> {
  let url = policy.sourceUrl(source, input);
  const origin = url.origin;
  for (let redirects = 0; ; redirects += 1) {
    await assertPublicAddress(url, dependencies.lookup);
    const response = await dependencies.fetch(url.href, {
      ...init,
      headers: headersWithDefaults(init.headers),
      redirect: 'manual',
      signal: init.signal ?? AbortSignal.timeout(defaultTimeoutMilliseconds),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (redirects >= maximumRedirects) throw new Error(`Source ${source} exceeded the redirect limit.`);
    const location = response.headers.get('location');
    if (!location) throw new Error(`Source ${source} returned a redirect without a location.`);
    const target = policy.sourceUrl(source, new URL(location, url).href);
    if (target.origin !== origin) throw new TypeError(`Source ${source} attempted a cross-origin redirect.`);
    url = target;
  }
}

function mediaType(response: Response): string {
  return (response.headers.get('content-type') ?? '').split(';', 1)[0]!.trim().toLowerCase();
}

export async function fetchSourceText(
  policy: SourceUrlPolicy, source: string, input: string, init: RequestInit = {},
  maximumBytes = maximumSourceBytes, dependencies: SourceHttpDependencies = defaultDependencies,
): Promise<{ readonly text: string; readonly url: string; readonly contentType: string }> {
  const response = await fetchSourceResponse(policy, source, input, init, dependencies);
  if (!response.ok) throw new Error(`Source ${source} request failed with HTTP ${response.status}.`);
  const bytes = await readResponseBytes(response, maximumBytes);
  return { text: new TextDecoder().decode(bytes), url: response.url || policy.sourceUrl(source, input).href,
    contentType: mediaType(response) };
}

export async function fetchSourceJson(
  policy: SourceUrlPolicy, source: string, input: string, init: RequestInit = {},
  maximumBytes = maximumSourceBytes, dependencies: SourceHttpDependencies = defaultDependencies,
): Promise<unknown> {
  const result = await fetchSourceText(policy, source, input, init, maximumBytes, dependencies);
  if (result.contentType !== 'application/json' && !result.contentType.endsWith('+json')) {
    throw new TypeError(`Source ${source} returned a non-JSON content type.`);
  }
  try { return JSON.parse(result.text); } catch { throw new SyntaxError(`Source ${source} returned invalid JSON.`); }
}

export async function fetchSourceHtml(
  policy: SourceUrlPolicy, source: string, input: string, maximumBytes = maximumSourceBytes,
  dependencies: SourceHttpDependencies = defaultDependencies,
): Promise<{ readonly html: string; readonly url: string }> {
  const result = await fetchSourceText(policy, source, input, { headers: { accept: 'text/html' } }, maximumBytes, dependencies);
  if (result.contentType !== 'text/html' && result.contentType !== 'application/xhtml+xml') {
    throw new TypeError(`Source ${source} returned a non-HTML content type.`);
  }
  return { html: result.text, url: result.url };
}

export function createSourceHttp(policy: SourceUrlPolicy, dependencies: SourceHttpDependencies = defaultDependencies): SourceHttp {
  return Object.freeze({
    ...policy,
    fetchSourceResponse: (source: string, input: string, init?: RequestInit) =>
      fetchSourceResponse(policy, source, input, init, dependencies),
    fetchSourceText: (source: string, input: string, init?: RequestInit, maximumBytes?: number) =>
      fetchSourceText(policy, source, input, init, maximumBytes, dependencies),
    fetchSourceJson: (source: string, input: string, init?: RequestInit, maximumBytes?: number) =>
      fetchSourceJson(policy, source, input, init, maximumBytes, dependencies),
    fetchSourceHtml: (source: string, input: string, maximumBytes?: number) =>
      fetchSourceHtml(policy, source, input, maximumBytes, dependencies),
  });
}

export type JsonObject = Record<string, unknown>;
export function asObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : null;
}

export function plainText(value: unknown): string {
  if (Array.isArray(value)) return value.map(plainText).filter(Boolean).join(', ');
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value).replace(/\s+/gu, ' ').trim();
  }
  return '';
}

const namedEntities: Readonly<Record<string, string>> = {
  amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"', ndash: '–', mdash: '—', laquo: '«', raquo: '»',
};
function decodeEntities(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/giu, (_whole, decimal, hex, name) => {
    if (decimal) return String.fromCodePoint(Number(decimal));
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    return namedEntities[String(name).toLowerCase()] ?? ' ';
  });
}
export function htmlText(value: string): string {
  return plainText(decodeEntities(value.replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/giu, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/div>|<\/h[1-6]>/giu, '\n').replace(/<[^>]*>/gu, ' ')));
}

const russianMonths = new Map([
  ['января', 0], ['февраля', 1], ['марта', 2], ['апреля', 3], ['мая', 4], ['июня', 5],
  ['июля', 6], ['августа', 7], ['сентября', 8], ['октября', 9], ['ноября', 10], ['декабря', 11],
]);
export function russianDate(text: string, now = new Date()): string | null {
  const match = /(?:^|\D)(\d{1,2})\s+([а-яё]+)(?:\s+(\d{4}))?(?:\D|$)/iu.exec(text);
  if (!match) return null;
  const month = russianMonths.get(match[2]!.toLowerCase());
  if (month === undefined) return null;
  let year = match[3] ? Number(match[3]) : now.getUTCFullYear();
  let date = new Date(Date.UTC(year, month, Number(match[1])));
  if (!match[3] && date.getTime() > now.getTime()) date = new Date(Date.UTC(--year, month, Number(match[1])));
  if (date.getUTCMonth() !== month || date.getUTCDate() !== Number(match[1])) return null;
  return date.toISOString();
}

function collectPostings(value: unknown, output: JsonObject[]): void {
  if (Array.isArray(value)) { for (const item of value) collectPostings(item, output); return; }
  const object = asObject(value); if (!object) return;
  const types = Array.isArray(object['@type']) ? object['@type'] : [object['@type']];
  if (types.includes('JobPosting')) output.push(object);
  if (object['@graph']) collectPostings(object['@graph'], output);
}
export function jobPostings(html: string): JsonObject[] {
  const output: JsonObject[] = [];
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/giu)) {
    try { collectPostings(JSON.parse(match[1]!), output); } catch { /* One malformed script must not hide valid siblings. */ }
  }
  return output;
}

export function parseSalaryText(value: string): SalaryRange | null {
  const numbers = [...value.replace(/[\s ]/gu, '').matchAll(/\d+(?:[.,]\d+)?/gu)].map((item) => Number(item[0].replace(',', '.')));
  if (numbers.length === 0) return null;
  const currencyMatch = /\b(RUB|RUR|USD|EUR|KZT|BYN)\b|₽|\$|€/iu.exec(value)?.[0]?.toUpperCase();
  const currency = currencyMatch === '$' ? 'USD' : currencyMatch === '€' ? 'EUR'
    : currencyMatch === '₽' || currencyMatch === 'RUR' ? 'RUB' : currencyMatch;
  if (!currency) return null;
  return {
    from: /(?:до|up to)/iu.test(value) && numbers.length === 1 ? null : numbers[0]!,
    to: numbers.length > 1 ? numbers[1]! : /(?:до|up to)/iu.test(value) ? numbers[0]! : null,
    currency: parseCurrencyCode(currency), gross: /(?:до вычета|gross)/iu.test(value) ? true
      : /(?:на руки|net)/iu.test(value) ? false : null,
    period: /(?:час|hour)/iu.test(value) ? 'hour' : /(?:день|day)/iu.test(value) ? 'day'
      : /(?:год|year)/iu.test(value) ? 'year' : 'month',
  };
}

function structuredSalary(posting: JsonObject): SalaryRange | null {
  const salary = asObject(posting.baseSalary); const value = asObject(salary?.value);
  const from = Number(value?.minValue ?? value?.value); const to = Number(value?.maxValue);
  const currency = plainText(salary?.currency || posting.salaryCurrency);
  if ((!Number.isFinite(from) && !Number.isFinite(to)) || !currency) return parseSalaryText(plainText(posting.baseSalary));
  return { from: Number.isFinite(from) ? from : null, to: Number.isFinite(to) ? to : null,
    currency: parseCurrencyCode(currency.toUpperCase()), gross: null,
    period: plainText(value?.unitText).toLowerCase().includes('year') ? 'year'
      : plainText(value?.unitText).toLowerCase().includes('hour') ? 'hour' : 'month' };
}

export function structuredLocation(posting: JsonObject): string {
  const locations = Array.isArray(posting.jobLocation) ? posting.jobLocation : [posting.jobLocation];
  const parts: string[] = [];
  for (const location of locations) {
    const item = asObject(location); const address = asObject(item?.address);
    for (const part of [address?.addressLocality, address?.addressRegion, address?.addressCountry, item?.name]) {
      const text = plainText(part); if (text && !parts.includes(text)) parts.push(text);
    }
  }
  return parts.join(', ') || plainText(posting.applicantLocationRequirements) || 'Не указано';
}

function employment(value: string): EmploymentType {
  const text = value.toLowerCase();
  if (text.includes('full')) return 'full-time'; if (text.includes('part')) return 'part-time';
  if (text.includes('intern')) return 'internship'; if (text.includes('contract')) return 'contract';
  if (text.includes('temp')) return 'temporary'; return text ? 'other' : 'unspecified';
}
function experience(posting: JsonObject): ExperienceRequirement {
  const object = asObject(posting.experienceRequirements); const months = Number(object?.monthsOfExperience);
  if (Number.isFinite(months) && months >= 0) return { kind: 'range', minimumYears: months / 12, maximumYears: null };
  const label = plainText(object?.description || posting.experienceRequirements);
  return label ? { kind: 'other', label } : { kind: 'unspecified' };
}
function schedule(value: string): WorkSchedule { return value ? 'other' : 'unspecified'; }
function workFormat(posting: JsonObject): WorkFormat {
  return plainText(posting.jobLocationType).toUpperCase().includes('TELECOMMUTE') ? 'remote' : 'unspecified';
}

function canonicalHashValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalHashValue);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalHashValue(item)]));
  }
  return value;
}

export function hashedVacancy(base: Omit<VacancyInput, 'contentHash'>): VacancyInput {
  // Runtime callers may spread a prior VacancyInput despite Omit; neither its hash nor private query is content.
  const { contentHash: _priorHash, sourceQuery: _privateQuery, ...content } = base as VacancyInput;
  const hashable = canonicalHashValue({
    ...content,
    url: base.url.href,
    publishedAt: base.publishedAt.toISOString(),
  });
  const digest = createHash('sha256').update(JSON.stringify(hashable)).digest('hex');
  return Object.freeze({ ...base, contentHash: parseVacancyContentHash(digest) });
}

export function structuredVacancy(
  source: string, sourceId: string, sourceUrl: string, sourceQuery: string, posting: JsonObject,
): VacancyInput | null {
  const status = plainText(posting.validThrough); const expiry = status ? new Date(status) : null;
  if (expiry && Number.isFinite(expiry.getTime()) && expiry.getTime() < Date.now()) return null;
  const name = plainText(posting.title); const description = htmlText(plainText(posting.description));
  if (!name || description.length < 20) throw new Error(`Source ${source} vacancy is missing required content.`);
  const publishedAt = new Date(plainText(posting.datePosted));
  if (!Number.isFinite(publishedAt.getTime())) throw new Error(`Source ${source} vacancy has an invalid publication date.`);
  const skills = plainText(posting.skills).split(/[;,]/u).map((item) => item.trim()).filter(Boolean).slice(0, 30);
  return hashedVacancy({
    source: parseSourceKey(source), sourceId: parseSourceVacancyId(sourceId), name,
    employer: plainText(asObject(posting.hiringOrganization)?.name) || 'Не указано', area: structuredLocation(posting),
    salary: structuredSalary(posting), experience: experience(posting), employment: employment(plainText(posting.employmentType)),
    schedule: schedule(plainText(posting.workHours)), workFormat: workFormat(posting), description,
    keySkills: Object.freeze(skills), url: new URL(sourceUrl), publishedAt, sourceQuery,
  });
}

export interface VacancySearchResult {
  readonly seen: number; readonly discovered: number; readonly discoveredBySearch?: Readonly<Record<string, number>>;
}

export class VacancySearchCollector {
  readonly #seen = new Set<string>();
  readonly #bySearch = new Map<string, number>();
  #discovered = 0;
  constructor(readonly newVacancyLimit: number,
    readonly recordListingCandidate: (input: VacancyCandidateInput) => Promise<boolean>) {
    byteLimit(newVacancyLimit);
  }
  get complete(): boolean { return this.#discovered >= this.newVacancyLimit; }
  async record(input: VacancyCandidateInput, recipients: readonly SearchRecipient[]): Promise<boolean> {
    if (this.complete) return false;
    const key = `${input.source.length}:${input.source}:${input.sourceId}`;
    if (this.#seen.has(key)) return false;
    this.#seen.add(key);
    if (!await this.recordListingCandidate(input)) return false;
    this.#discovered += 1;
    for (const name of new Set(recipients.map((recipient) => recipient.searchName))) {
      this.#bySearch.set(name, (this.#bySearch.get(name) ?? 0) + 1);
    }
    return true;
  }
  result(): VacancySearchResult {
    const bySearch = Object.fromEntries([...this.#bySearch].sort(([left], [right]) => left.localeCompare(right)));
    return Object.freeze({ seen: this.#seen.size, discovered: this.#discovered,
      ...(this.#bySearch.size ? { discoveredBySearch: Object.freeze(bySearch) } : {}) });
  }
}
