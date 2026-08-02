import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { config } from '../config.ts';
import { type VacancyCandidate, type VacancyInput } from './database.ts';
import { hhSearchUrl, type HhSearchProfile } from '../platforms/hh.ts';
import { trace } from './trace.ts';
import { VacancySearchCollector } from './vacancy-search-collector.ts';
import { assertPublicAddress, sourceUrl } from './url-security.ts';

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
  const browserData = join(dirname(config.databasePath), 'hh-browser');
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

export async function scrapeHh(userId: string, profile: HhSearchProfile): Promise<{ seen: number; discovered: number }> {
  const context = await openContext();
  const page = context.pages()[0] ?? await context.newPage();
  const collector = new VacancySearchCollector(userId, config.searchNewVacancyLimit);
  try {
    searches: for (const search of profile.searches) {
      for (let pageNumber = 0; pageNumber < config.hhMaxPages; pageNumber++) {
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
          if (id) collector.record({ source: 'hh', sourceId: id, url: `https://hh.ru/vacancy/${id}`,
            searchName: search.name, title: item.title, summary: search.name });
          if (collector.complete) break;
        }
        if (collector.complete) break searches;
        if (found.length === 0 || !await page.locator('[data-qa="pager-next"]').count()) break;
        await pause();
      }
    }
    return collector.result();
  } finally {
    await context.close();
  }
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
