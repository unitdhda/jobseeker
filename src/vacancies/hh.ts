import * as v from 'valibot';
import { config } from '../config.ts';
import type { SearchPlatform } from './registry.ts';

const id = v.pipe(v.string(), v.regex(/^\d+$/, 'Expected a numeric HH identifier'));
const shortText = v.pipe(v.string(), v.minLength(1), v.maxLength(240));
const ids = v.optional(v.pipe(v.array(id), v.maxLength(20)));
const searchFields = ['name', 'company_name', 'description'] as const;
const experiences = ['noExperience', 'between1And3', 'between3And6', 'moreThan6'] as const;
const employmentForms = ['FULL', 'PART', 'PROJECT', 'FLY_IN_FLY_OUT'] as const;
const workFormats = ['ON_SITE', 'REMOTE', 'HYBRID', 'FIELD_WORK'] as const;
const schedules = ['SIX_ON_ONE_OFF', 'FIVE_ON_TWO_OFF', 'FOUR_ON_FOUR_OFF', 'FOUR_ON_THREE_OFF', 'FOUR_ON_TWO_OFF', 'THREE_ON_THREE_OFF', 'THREE_ON_TWO_OFF', 'TWO_ON_TWO_OFF', 'TWO_ON_ONE_OFF', 'ONE_ON_THREE_OFF', 'ONE_ON_TWO_OFF', 'WEEKEND', 'FLEXIBLE', 'OTHER'] as const;
const hours = ['HOURS_2', 'HOURS_3', 'HOURS_4', 'HOURS_5', 'HOURS_6', 'HOURS_7', 'HOURS_8', 'HOURS_9', 'HOURS_10', 'HOURS_11', 'HOURS_12', 'HOURS_24', 'FLEXIBLE', 'OTHER'] as const;
const labels = ['with_address', 'accept_handicapped', 'not_from_agency', 'accept_kids', 'accredited_it', 'low_performance', 'internship', 'night_shifts', 'with_salary', 'accept_teens', 'accept_labor_contract'] as const;
const currencies = ['AZN', 'BYR', 'EUR', 'GEL', 'KGS', 'KZT', 'RUR', 'UAH', 'USD', 'UZS'] as const;

export const hhSearchProfileSchema = v.strictObject({
  version: v.literal(1),
  searches: v.pipe(v.array(v.strictObject({
    name: v.pipe(v.string(), v.minLength(2), v.maxLength(80)),
    rationale: v.pipe(v.string(), v.minLength(2), v.maxLength(300)),
    text: v.pipe(v.string(), v.minLength(2), v.maxLength(300),
      v.regex(/[А-Яа-яЁё]/, 'Search text must include a Russian role or function phrase')),
    excludedText: v.optional(shortText),
    searchFields: v.optional(v.pipe(v.array(v.picklist(searchFields)), v.minLength(1), v.maxLength(3))),
    areas: v.pipe(v.array(id), v.minLength(1), v.maxLength(10)),
    metro: ids,
    professionalRoles: ids,
    industries: ids,
    employerIds: ids,
    experience: v.optional(v.pipe(v.array(v.picklist(experiences)), v.maxLength(4))),
    employmentForms: v.optional(v.pipe(v.array(v.picklist(employmentForms)), v.maxLength(4))),
    workSchedules: v.optional(v.pipe(v.array(v.picklist(schedules)), v.maxLength(14))),
    workingHours: v.optional(v.pipe(v.array(v.picklist(hours)), v.maxLength(14))),
    workFormats: v.optional(v.pipe(v.array(v.picklist(workFormats)), v.maxLength(4))),
    education: v.optional(v.pipe(v.array(v.picklist(['not_required_or_not_specified', 'special_secondary', 'higher'])), v.maxLength(3))),
    driverLicenseTypes: v.optional(v.pipe(v.array(v.pipe(v.string(), v.regex(/^[A-Z0-9]+$/))), v.maxLength(10))),
    labels: v.optional(v.pipe(v.array(v.picklist(labels)), v.maxLength(11))),
    salary: v.optional(v.strictObject({
      amount: v.pipe(v.number(), v.integer(), v.minValue(1)),
      currency: v.picklist(currencies),
      frequency: v.optional(v.picklist(['DAILY', 'WEEKLY', 'TWICE_PER_MONTH', 'MONTHLY', 'PER_PROJECT'])),
      mode: v.optional(v.picklist(['MONTH', 'SHIFT', 'HOUR', 'FLY_IN_FLY_OUT', 'SERVICE'])),
    })),
    periodDays: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(30))),
    orderBy: v.optional(v.picklist(['publication_time', 'salary_desc', 'salary_asc', 'relevance'])),
  })), v.minLength(1), v.maxLength(8)),
});

export type HhSearchProfile = v.InferOutput<typeof hhSearchProfileSchema>;
export type HhSearch = HhSearchProfile['searches'][number];

export const hhPlatform: SearchPlatform<typeof hhSearchProfileSchema> = {
  id: 'hh',
  name: 'hh.ru browser search',
  schema: hhSearchProfileSchema,
  template: () => ({
    platform: 'hh',
    version: 1,
    purpose: 'Validated inputs for the hh.ru vacancy-search web page. Playwright opens these searches; this is not an API request.',
    jsonShape: {
      version: 1,
      searches: [{
        name: 'CV-derived track', rationale: 'CV evidence for this role search',
        text: 'название профессии из карьерного профиля', searchFields: ['name', 'description'],
        areas: [config.hhAreaId], periodDays: 7, orderBy: 'publication_time',
      }],
    },
    capabilities: {
      configuredDefaultArea: config.hhAreaId,
      searchFields, experiences, employmentForms, workFormats, workSchedules: schedules,
      workingHours: hours, labels, currencies,
      education: ['not_required_or_not_specified', 'special_secondary', 'higher'],
      salaryFrequencies: ['DAILY', 'WEEKLY', 'TWICE_PER_MONTH', 'MONTHLY', 'PER_PROJECT'],
      salaryModes: ['MONTH', 'SHIFT', 'HOUR', 'FLY_IN_FLY_OUT', 'SERVICE'],
      orderBy: ['publication_time', 'salary_desc', 'salary_asc', 'relevance'],
      professionalRoles: 'No role-ID catalogue is embedded. Omit this filter unless an operator supplies a verified HH role ID.',
    },
    rules: [
      'Every search text must contain Russian role or function terms; keep only standard technology and product names in English.',
      'Use only capabilities listed by this template; omit unsupported or unknown filters.',
      'Every search must include areas; use configuredDefaultArea unless the CV explicitly supports another location.',
      'Never infer salary, work format, education, licences, or availability merely from a job title.',
      'Prefer several complementary searches over one over-filtered search.',
      'Omit professionalRoles unless an exact verified HH role ID was supplied by operator configuration.',
      'Use strict filters only when they are explicit in the CV or operator input; recall matters.',
    ],
  }),
};

function appendMany(params: URLSearchParams, name: string, values?: readonly string[]): void {
  for (const value of values ?? []) params.append(name, value);
}

export function hhSearchUrl(search: HhSearch, page: number): string {
  const params = new URLSearchParams({ text: search.text, page: String(page), per_page: '100' });
  appendMany(params, 'search_field', search.searchFields);
  appendMany(params, 'area', search.areas);
  appendMany(params, 'metro', search.metro);
  appendMany(params, 'professional_role', search.professionalRoles);
  appendMany(params, 'industry', search.industries);
  appendMany(params, 'employer_id', search.employerIds);
  appendMany(params, 'experience', search.experience);
  appendMany(params, 'employment_form', search.employmentForms);
  appendMany(params, 'work_schedule_by_days', search.workSchedules);
  appendMany(params, 'working_hours', search.workingHours);
  appendMany(params, 'work_format', search.workFormats);
  appendMany(params, 'education', search.education);
  appendMany(params, 'driver_license_types', search.driverLicenseTypes);
  appendMany(params, 'label', search.labels);
  if (search.excludedText) params.set('excluded_text', search.excludedText);
  if (search.salary) {
    params.set('salary', String(search.salary.amount));
    params.set('currency', search.salary.currency);
    if (search.salary.frequency) params.set('salary_frequency', search.salary.frequency);
    if (search.salary.mode) params.set('salary_mode', search.salary.mode);
  }
  params.set('period', String(search.periodDays ?? 7));
  params.set('order_by', search.orderBy ?? 'publication_time');
  return `https://hh.ru/search/vacancy?${params}`;
}

import { createHash } from 'node:crypto';

import { chromium, type BrowserContext, type Page } from 'playwright';
import { type VacancyCandidate, type VacancyInput } from '../database.ts';
import { trace } from '../observability.ts';
import { VacancySearchCollector } from './http.ts';
import { assertPublicAddress, sourceUrl } from './http.ts';

async function pause(min = 350, max = 900): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));
}

async function visibleText(page: Page, selector: string): Promise<string> {
  const locator = page.locator(selector).first();
  return await locator.count() ? (await locator.innerText()).trim() : '';
}

async function assertSearchPage(page: Page): Promise<void> {
  const body = (await page.locator('body').innerText()).slice(0, 2_000).toLowerCase();
  if (page.url().includes('captcha') || body.includes('подтвердите, что вы не робот')) {
    throw new Error('hh.ru requested a captcha; open the persistent browser profile interactively before retrying.');
  }
}

function parseSalary(text: string): Pick<VacancyInput, 'salaryFrom' | 'salaryTo' | 'salaryCurrency' | 'salaryGross'> {
  const normalized = text.replace(/\u00a0/g, ' ').trim();
  if (!normalized || /не указан/i.test(normalized)) {
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
    : normalized.includes('$') ? 'USD' : normalized.includes('€') ? 'EUR'
    : normalized.match(/\b(USD|EUR|KZT|BYR|UZS|GEL|KGS|AZN)\b/i)?.[1]?.toUpperCase() ?? null;
  const salaryGross = /на руки/i.test(normalized) ? false : /до вычета/i.test(normalized) ? true : null;
  return { salaryFrom, salaryTo, salaryCurrency, salaryGross };
}

async function stripVacancy(page: Page, url: string, sourceQuery: string): Promise<VacancyInput> {
  const safe = sourceUrl('hh', url); await assertPublicAddress(safe);
  const safeUrl = safe.toString();
  await page.goto(safeUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  sourceUrl('hh', page.url());
  await assertSearchPage(page);
  await page.locator('[data-qa="vacancy-title"]').waitFor({ state: 'visible', timeout: 20_000 });

  const hhId = new URL(page.url()).pathname.match(/\/vacancy\/(\d+)/)?.[1];
  if (!hhId) throw new Error(`Cannot determine HH vacancy id from ${page.url()}`);
  const name = await visibleText(page, '[data-qa="vacancy-title"]');
  const titleBlock = await page.locator('[data-qa="vacancy-title"]').locator('..').innerText();
  const salaryText = titleBlock.split('\n').map((line) => line.trim()).filter(Boolean).find((line) => line !== name) ?? '';
  const employer = await visibleText(page, '[data-qa="vacancy-company-name"]');
  const area = await visibleText(page, '[data-qa="vacancy-address-with-map"]');
  const experience = await visibleText(page, '[data-qa="vacancy-experience"]');
  const employment = await visibleText(page, '[data-qa="common-employment-text"]');
  const scheduleParts = await Promise.all([
    visibleText(page, '[data-qa="work-schedule-by-days-text"]'),
    visibleText(page, '[data-qa="working-hours-text"]'),
  ]);
  const workFormat = await visibleText(page, '[data-qa="work-formats-text"]');
  const description = await visibleText(page, '[data-qa="vacancy-description"]');
  const canonicalUrl = `https://hh.ru/vacancy/${hhId}`;
  const salary = parseSalary(salaryText);
  const base = {
    source: 'hh', sourceId: hhId, name, employer, area, ...salary, experience, employment,
    schedule: scheduleParts.filter(Boolean).join(' · '), workFormat, description,
    keySkills: [] as string[], url: canonicalUrl, publishedAt: new Date().toISOString(), sourceQuery,
  };
  return { ...base, contentHash: createHash('sha256').update(JSON.stringify(base)).digest('hex') };
}

async function openContext(): Promise<BrowserContext> {
  const browserData = config.hhBrowserDataPath;
  return chromium.launchPersistentContext(browserData, {
    executablePath: config.playwrightChromiumPath,
    headless: config.playwrightHeadless,
    locale: 'ru-RU',
    timezoneId: config.timezone,
    viewport: { width: 1440, height: 1000 },
    chromiumSandbox: true,
    env: {
      HOME: browserData,
      LANG: process.env.LANG ?? 'C.UTF-8',
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      TMPDIR: '/tmp',
    },
    args: ['--disable-dev-shm-usage'],
  });
}

async function closeContextBounded(context:BrowserContext):Promise<void>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([context.close(),new Promise<void>(resolve=>{timer=setTimeout(resolve,5_000);})]);}
  finally{if(timer)clearTimeout(timer);}
}

export async function scrapeHh(userId: string, profile: HhSearchProfile): Promise<{ seen: number; discovered: number }> {
  const context = await openContext();
  const timeoutMessage=`HH browser search exceeded ${config.hhOperationTimeoutSeconds} seconds.`;
  let deadline:ReturnType<typeof setTimeout>|undefined;
  const timedOut=new Promise<never>((_resolve,reject)=>{deadline=setTimeout(()=>{
    void context.close({reason:timeoutMessage}).catch(()=>undefined);reject(new Error(timeoutMessage));
  },config.hhOperationTimeoutSeconds*1_000);});
  const operation=(async()=>{
    const page = context.pages()[0] ?? await context.newPage();
    const collector = new VacancySearchCollector(userId, config.searchNewVacancyLimit);
    const pagesPerSearch=Math.max(1,Math.min(config.hhMaxPages,
      Math.floor(config.searchPageBudgetPerPlatform/Math.max(1,profile.searches.length))));
    searches: for (const search of profile.searches) {
      for (let pageNumber = 0; pageNumber < pagesPerSearch; pageNumber++) {
        const safeSearchUrl = sourceUrl('hh', hhSearchUrl(search, pageNumber)); await assertPublicAddress(safeSearchUrl);
        const searchUrl = safeSearchUrl.toString();
        trace('scrape.search.request', { platform: 'hh', search: search.name, page: pageNumber + 1, url: searchUrl });
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        sourceUrl('hh', page.url());
        await assertSearchPage(page);
        const found = await page.locator('[data-qa="serp-item__title"]').evaluateAll((anchors) =>
          anchors.map((anchor) => ({ href: (anchor as HTMLAnchorElement).href, title: anchor.textContent?.trim() ?? '' })));
        trace('scrape.search.result', { platform: 'hh', search: search.name, page: pageNumber + 1, found: found.length });
        for (const item of found) {
          const id = new URL(item.href).pathname.match(/\/vacancy\/(\d+)/)?.[1];
          if (id) await collector.record({ source: 'hh', sourceId: id, url: `https://hh.ru/vacancy/${id}`,
            searchName: search.name, title: item.title, summary: search.name });
          if (collector.complete) break;
        }
        if (collector.complete) break searches;
        if (found.length === 0 || !await page.locator('[data-qa="pager-next"]').count()) break;
        await pause();
      }
    }
    return collector.result();
  })();
  try{return await Promise.race([operation,timedOut]);}
  finally{if(deadline)clearTimeout(deadline);await closeContextBounded(context);}
}

export async function normalizeHhCandidates(candidates: VacancyCandidate[]): Promise<Map<string, VacancyInput | Error>> {
  const results = new Map<string, VacancyInput | Error>();
  if (!candidates.length) return results;
  const context = await openContext();
  const page = context.pages()[0] ?? await context.newPage();
  try {
    for (const candidate of candidates) {
      try {
        results.set(candidate.sourceId, await stripVacancy(page, candidate.url, candidate.searchName));
        await pause(500, 1_200);
      } catch (error) { results.set(candidate.sourceId, error instanceof Error ? error : new Error(String(error))); }
    }
  } finally { await context.close(); }
  return results;
}
