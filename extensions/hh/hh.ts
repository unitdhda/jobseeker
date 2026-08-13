import * as v from 'valibot';
import { chromium, type BrowserContext, type Page } from 'playwright';
import type { VacancyCandidate, VacancyInput } from '@jobseeker/engine/contracts';
import type { SearchPlan, SearchPlatform, SourceContext } from '@jobseeker/sources';
import {
  AdaptiveTaskPool,
  assertPublicAddress,
  assertToolkitInitialized,
  createSourceProvider,
  hashedVacancy,
  jobPostings,
  parseSalaryText,
  parseSourceKey,
  parseSourceVacancyId,
  plainText,
  russianDate,
  VacancySearchCollector,
} from './toolkit.ts';

const numericId = v.pipe(v.string(), v.regex(/^\d+$/u, 'Expected a numeric HH identifier.'));
const ids = v.optional(v.pipe(v.array(numericId), v.maxLength(20)));
const shortText = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(240));
const searchFields = ['name', 'company_name', 'description'] as const;
const experiences = ['noExperience', 'between1And3', 'between3And6', 'moreThan6'] as const;
const employmentForms = ['FULL', 'PART', 'PROJECT', 'FLY_IN_FLY_OUT'] as const;
const workFormats = ['ON_SITE', 'REMOTE', 'HYBRID', 'FIELD_WORK'] as const;
const schedules = ['FIVE_ON_TWO_OFF', 'TWO_ON_TWO_OFF', 'FLEXIBLE', 'WEEKEND', 'OTHER'] as const;
const hours = ['HOURS_4', 'HOURS_6', 'HOURS_8', 'HOURS_12', 'FLEXIBLE', 'OTHER'] as const;
const labels = ['with_address', 'accept_handicapped', 'not_from_agency', 'accredited_it', 'internship', 'with_salary'] as const;
const currencies = ['RUR', 'USD', 'EUR', 'KZT', 'BYR'] as const;

export const maxHhSearches = 8;
export const hhSearchProfileSchema = v.strictObject({
  version: v.literal(1),
  searches: v.pipe(v.array(v.strictObject({
    name: v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(80)),
    rationale: v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(300)),
    text: v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(300),
      v.regex(/[А-Яа-яЁё]/u, 'Search text must include Russian role terms.')),
    excludedText: v.optional(shortText),
    searchFields: v.optional(v.pipe(v.array(v.picklist(searchFields)), v.minLength(1), v.maxLength(3))),
    areas: v.pipe(v.array(numericId), v.minLength(1), v.maxLength(10)),
    metro: ids, professionalRoles: ids, industries: ids, employerIds: ids,
    experience: v.optional(v.pipe(v.array(v.picklist(experiences)), v.maxLength(experiences.length))),
    employmentForms: v.optional(v.pipe(v.array(v.picklist(employmentForms)), v.maxLength(employmentForms.length))),
    workSchedules: v.optional(v.pipe(v.array(v.picklist(schedules)), v.maxLength(schedules.length))),
    workingHours: v.optional(v.pipe(v.array(v.picklist(hours)), v.maxLength(hours.length))),
    workFormats: v.optional(v.pipe(v.array(v.picklist(workFormats)), v.maxLength(workFormats.length))),
    education: v.optional(v.pipe(v.array(v.picklist(['not_required_or_not_specified', 'special_secondary', 'higher'])), v.maxLength(3))),
    driverLicenseTypes: v.optional(v.pipe(v.array(v.pipe(v.string(), v.regex(/^[A-Z0-9]+$/u))), v.maxLength(10))),
    labels: v.optional(v.pipe(v.array(v.picklist(labels)), v.maxLength(labels.length))),
    salary: v.optional(v.strictObject({ amount: v.pipe(v.number(), v.integer(), v.minValue(1)), currency: v.picklist(currencies),
      frequency: v.optional(v.picklist(['DAILY', 'WEEKLY', 'TWICE_PER_MONTH', 'MONTHLY', 'PER_PROJECT'])),
      mode: v.optional(v.picklist(['MONTH', 'SHIFT', 'HOUR', 'FLY_IN_FLY_OUT', 'SERVICE'])) })),
    periodDays: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(30))),
    orderBy: v.optional(v.picklist(['publication_time', 'salary_desc', 'salary_asc', 'relevance'])),
  })), v.minLength(1), v.maxLength(maxHhSearches)),
});
export type HhSearchProfile = v.InferOutput<typeof hhSearchProfileSchema>;
export type HhSearch = HhSearchProfile['searches'][number];

export function hhPlatform(areaId: string): SearchPlatform<typeof hhSearchProfileSchema> {
  if (!/^\d+$/u.test(areaId)) throw new TypeError('Invalid default HH area ID.');
  return Object.freeze({ id: 'hh', name: 'hh.ru browser search', hosts: ['hh.ru', 'www.hh.ru'],
    schema: hhSearchProfileSchema, mergeText: 'or', template: () => ({
      platform: 'hh', version: 1, purpose: 'Validated browser searches for hh.ru.',
      jsonShape: { version: 1, searches: [{ name: 'CV track', rationale: 'Direct evidence', text: 'разработчик', areas: [areaId], periodDays: 7 }] },
      capabilities: { maxSearches: maxHhSearches, configuredDefaultArea: areaId, periodDays: '1–30', mergeText: 'or' },
      rules: ['Return at most 8 searches.', 'Search text must contain Russian role terms.',
        'Every search requires areas.', 'Never infer salary or strict filters without evidence.'],
    }) });
}

function appendMany(params: URLSearchParams, key: string, values?: readonly string[]): void {
  for (const value of values ?? []) params.append(key, value);
}
export function hhSearchUrl(search: HhSearch, page: number): string {
  if (!Number.isSafeInteger(page) || page < 0) throw new RangeError('Invalid HH page.');
  const params = new URLSearchParams({ text: search.text, page: String(page), per_page: '100',
    period: String(search.periodDays ?? 7), order_by: search.orderBy ?? 'publication_time' });
  for (const [key, values] of [['search_field', search.searchFields], ['area', search.areas], ['metro', search.metro],
    ['professional_role', search.professionalRoles], ['industry', search.industries], ['employer_id', search.employerIds],
    ['experience', search.experience], ['employment_form', search.employmentForms], ['work_schedule_by_days', search.workSchedules],
    ['working_hours', search.workingHours], ['work_format', search.workFormats], ['education', search.education],
    ['driver_license_types', search.driverLicenseTypes], ['label', search.labels]] as const) appendMany(params, key, values);
  if (search.excludedText) params.set('excluded_text', search.excludedText);
  if (search.salary) { params.set('salary', String(search.salary.amount)); params.set('currency', search.salary.currency);
    if (search.salary.frequency) params.set('salary_frequency', search.salary.frequency);
    if (search.salary.mode) params.set('salary_mode', search.salary.mode); }
  return `https://hh.ru/search/vacancy?${params}`;
}

export function hhPublishedAt(html: string, bodyText: string, now = new Date()): string | null {
  const posted = plainText(jobPostings(html)[0]?.datePosted);
  if (posted && Number.isFinite(Date.parse(posted))) return new Date(posted).toISOString();
  const match = /Вакансия опубликована\s+(\d{1,2}\s+\p{L}+(?:\s+\d{4})?)/u.exec(bodyText);
  return match ? russianDate(match[1]!, now) : null;
}

export class HhCaptchaError extends Error { constructor() { super('hh.ru requested a captcha.'); this.name = 'HhCaptchaError'; } }
export interface HhBrowserOptions {
  readonly browserDataPath: string; readonly operationTimeoutSeconds: number; readonly playwrightHeadless: boolean;
  readonly playwrightChromiumPath?: string; readonly timezone: string;
  readonly browserEnvironment: { readonly lang: string; readonly path: string; readonly tmpdir: string };
}
export interface HhBrowserRuntime {
  run<T>(operationName: string, operation: (context: BrowserContext) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export interface HhBrowserDependencies {
  launchPersistentContext(path: string, options: Parameters<typeof chromium.launchPersistentContext>[1]): Promise<BrowserContext>;
  sleep(milliseconds: number): Promise<void>;
}
const browserDefaults: HhBrowserDependencies = {
  launchPersistentContext: (path, options) => chromium.launchPersistentContext(path, options),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};
async function closeBounded(context: BrowserContext): Promise<void> {
  await Promise.race([context.close().catch(() => {}), new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
}
export function createHhBrowser(options: HhBrowserOptions, dependencies: HhBrowserDependencies = browserDefaults): HhBrowserRuntime {
  if (!Number.isFinite(options.operationTimeoutSeconds) || options.operationTimeoutSeconds <= 0) throw new RangeError('Invalid HH operation timeout.');
  let current: BrowserContext | undefined; let closed = false;
  const open = async (): Promise<BrowserContext> => {
    if (closed) throw new Error('HH browser is closed.');
    if (current) return current;
    let failure: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) try {
      const context = await dependencies.launchPersistentContext(options.browserDataPath, {
        executablePath: options.playwrightChromiumPath, headless: options.playwrightHeadless,
        locale: 'ru-RU', timezoneId: options.timezone, viewport: { width: 1440, height: 1000 }, chromiumSandbox: true,
        serviceWorkers: 'block', env: { HOME: options.browserDataPath, LANG: options.browserEnvironment.lang,
          PATH: options.browserEnvironment.path, TMPDIR: options.browserEnvironment.tmpdir }, args: ['--disable-dev-shm-usage'],
      });
      await context.route('**/*', (route) => ['image', 'media', 'font'].includes(route.request().resourceType()) ? route.abort() : route.continue());
      current = context; return context;
    } catch (error) { failure = error; if (attempt < 3) await dependencies.sleep(attempt * 250); }
    throw failure;
  };
  return Object.freeze({
    async run<T>(_operationName: string, operation: (context: BrowserContext) => Promise<T>): Promise<T> {
      const context = await open(); let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([operation(context), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('HH browser operation timed out.')), options.operationTimeoutSeconds * 1_000);
      })]); } catch (error) { if (current === context) { current = undefined; await closeBounded(context); } throw error; }
      finally { if (timer) clearTimeout(timer); }
    },
    async close(): Promise<void> { if (closed) return; closed = true; const context = current; current = undefined; if (context) await closeBounded(context); },
  });
}

async function bodyText(page: Page): Promise<string> { return (await page.locator('body').innerText()).slice(0, 20_000); }
async function assertUsable(page: Page): Promise<void> {
  const text = (await bodyText(page)).toLocaleLowerCase();
  if (page.url().includes('captcha') || text.includes('подтвердите, что вы не робот')) throw new HhCaptchaError();
}
async function navigate(page: Page, url: string): Promise<void> {
  const parsed = new URL(url); await assertPublicAddress(parsed); await page.goto(parsed.href, { waitUntil: 'domcontentloaded' }); await assertUsable(page);
}

export async function scrapeHh(plan: SearchPlan<HhSearch>, sourceContext: SourceContext,
  browser: HhBrowserRuntime, maxPages: number) {
  const collector = new VacancySearchCollector(sourceContext.limits.searchNewVacancyLimit, sourceContext.recordListingCandidate);
  const pages = Math.min(maxPages, Math.max(1, Math.floor(sourceContext.limits.searchPageBudgetPerPlatform / Math.max(1, plan.searches.length))));
  await browser.run('discovery', async (context) => {
    const page = context.pages()[0] ?? await context.newPage();
    for (const planned of plan.searches) for (let index = 0; index < pages && !collector.complete; index += 1) {
      await navigate(page, hhSearchUrl(planned.search, index));
      const cards = await page.locator('[data-qa="vacancy-serp__vacancy"]').evaluateAll((nodes) => nodes.map((node) => {
        const link = node.querySelector('[data-qa="serp-item__title"]') as HTMLAnchorElement | null;
        return { url: link?.href ?? '', title: link?.textContent?.trim() ?? '' };
      }));
      if (cards.length === 0) break;
      for (const card of cards) { const id = /\/vacancy\/(\d+)/u.exec(card.url)?.[1]; if (!id || !card.title) continue;
        await collector.record({ source: parseSourceKey('hh'), sourceId: parseSourceVacancyId(id),
          url: sourceContext.http.sourceUrl('hh', `https://hh.ru/vacancy/${id}`), searchName: planned.search.name, title: card.title }, planned.recipients); }
    }
  });
  return collector.result();
}

async function text(page: Page, selector: string): Promise<string> {
  const item = page.locator(selector).first(); return await item.count() ? (await item.innerText()).trim() : '';
}
async function normalizePage(page: Page, candidate: VacancyCandidate, context: SourceContext): Promise<VacancyInput | null> {
  await navigate(page, candidate.url.href); let body = await bodyText(page);
  if (/вакансия закрыта|вакансия в архиве/iu.test(body)) return null;
  await page.locator('[data-qa="vacancy-title"]').waitFor({ state: 'visible' });
  body = await bodyText(page); if (/вакансия закрыта|вакансия в архиве/iu.test(body)) return null;
  const name = await text(page, '[data-qa="vacancy-title"]');
  const description = await text(page, '[data-qa="vacancy-description"]');
  if (!name || description.length < 20) throw new Error('HH vacancy is missing required content.');
  const published = hhPublishedAt(await page.content(), body);
  if (!published) context.trace('hh.publication-date-fallback', { source: 'hh', reason: 'missing' });
  const salary = parseSalaryText(await text(page, '[data-qa="vacancy-salary"]'));
  const formatText = await text(page, '[data-qa="work-formats-text"]');
  return hashedVacancy({ source: parseSourceKey('hh'), sourceId: candidate.sourceId, name,
    employer: await text(page, '[data-qa="vacancy-company-name"]') || 'Не указано',
    area: await text(page, '[data-qa="vacancy-address-with-map"]') || 'Не указано', salary,
    experience: (await text(page, '[data-qa="vacancy-experience"]')) ? { kind: 'other', label: await text(page, '[data-qa="vacancy-experience"]') } : { kind: 'unspecified' },
    employment: (await text(page, '[data-qa="common-employment-text"]')) ? 'other' : 'unspecified', schedule: 'unspecified',
    workFormat: /удален|remote/iu.test(formatText) ? 'remote' : /гибрид|hybrid/iu.test(formatText) ? 'hybrid' : 'unspecified',
    description, keySkills: [], url: new URL(`https://hh.ru/vacancy/${candidate.sourceId}`),
    publishedAt: new Date(published ?? Date.now()), sourceQuery: candidate.searchName });
}
export async function normalizeHhCandidates(candidates: readonly VacancyCandidate[], context: SourceContext,
  browser: HhBrowserRuntime): Promise<Map<string, VacancyInput | null | Error>> {
  const results = new Map<string, VacancyInput | null | Error>();
  for (const candidate of candidates) try {
    await browser.run('normalization', async (browserContext) => {
      const page = browserContext.pages()[0] ?? await browserContext.newPage();
      results.set(candidate.sourceId, await normalizePage(page, candidate, context));
    });
  } catch (error) { results.set(candidate.sourceId, error instanceof Error ? error : new Error(context.errorMessage(error))); }
  return results;
}

export interface HhSourceOptions extends HhBrowserOptions { readonly areaId: string; readonly maxPages: number; readonly browser?: HhBrowserRuntime }
const defaults: HhSourceOptions = { areaId: '1', maxPages: 1, browserDataPath: '/tmp/jobseeker-hh-browser',
  operationTimeoutSeconds: 180, playwrightHeadless: true, timezone: 'Europe/Moscow',
  browserEnvironment: { lang: 'C.UTF-8', path: '/usr/local/bin:/usr/bin:/bin', tmpdir: '/tmp' } };
export function hhSource(input: Partial<HhSourceOptions> = {}) {
  assertToolkitInitialized(); const options = { ...defaults, ...input,
    browserEnvironment: { ...defaults.browserEnvironment, ...input.browserEnvironment } };
  const pool = new AdaptiveTaskPool(1, 1); const browser = input.browser ?? createHhBrowser(options);
  return createSourceProvider({ ...hhPlatform(options.areaId),
    async discover(plan, context) { const users = new Set(plan.searches.flatMap(({ recipients }) => recipients.map(({ userId }) => userId)));
      return { searches: plan.searches.length, users: users.size, ...await pool.run(() => scrapeHh(plan, context, browser, options.maxPages)) }; },
    normalize: (candidates, context) => pool.run(() => normalizeHhCandidates(candidates, context, browser)),
    close: () => browser.close(),
  });
}
