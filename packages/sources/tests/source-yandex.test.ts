import assert from 'node:assert/strict';
import test from 'node:test';
import type { VacancyCandidate } from '@jobseeker/engine/contracts';
import { companyPlatform, companyVacancyInput, mainVacancyText } from '@jobseeker/sources/drivers/company-site';
import { createCompanySiteSource } from '@jobseeker/sources/drivers/company-site';
import { createSources } from '@jobseeker/sources';
import {
  yandexCompanySite, yandexCursor, yandexListingPage, yandexSearchUrl, yandexSource,
} from '../examples/yandex.ts';
import { createSourceUrlPolicy } from '@jobseeker/sources';

const yandexUrlPolicy = createSourceUrlPolicy([yandexSource()]);

const yandexPayload = {
  next: 'http://femida.yandex-team.ru/_api/jobs/publications/?cursor=bz0xOCZwPTI%3D&page_size=20',
  results: [
    {
      id: 47527,
      publication_slug_url: 'produktoviy-analitik-v-telemost-i-messendzher-47527',
      title: 'Продуктовый аналитик в Телемост и Мессенджер',
      short_summary: 'Ищем аналитика для продуктовых и маркетинговых задач.',
      redirect_url: null,
      vacancy: {
        cities: [{ name: 'Москва' }, { name: 'Санкт-Петербург' }],
        skills: [{ name: 'SQL' }, { name: 'Python' }],
        work_modes: [{ name: 'Гибридный' }],
        employment_types: ['office'],
      },
    },
    {
      id: 999,
      publication_slug_url: 'external-999',
      title: 'Внешняя вакансия',
      redirect_url: 'https://other.example/jobs/999',
      vacancy: {},
    },
  ],
};

test('Yandex company API pages become canonical listings without trusting the internal next host', () => {
  const page = yandexListingPage(yandexPayload);
  assert.equal(page.nextCursor, 'bz0xOCZwPTI=');
  assert.equal(page.listings.length, 1, 'publications redirected to an undeclared company site are skipped');
  assert.deepEqual(page.listings[0], {
    sourceId: '47527',
    url: 'https://yandex.ru/jobs/vacancies/produktoviy-analitik-v-telemost-i-messendzher-47527',
    title: 'Продуктовый аналитик в Телемост и Мессенджер',
    summary: 'Ищем аналитика для продуктовых и маркетинговых задач.',
    employer: 'Яндекс',
    area: 'Москва, Санкт-Петербург',
    experience: '',
    employment: 'office',
    workFormat: 'Гибридный',
    keySkills: ['SQL', 'Python'],
  });
  assert.equal(yandexCursor('not a url'), undefined);
});

test('Yandex search pagination is rebuilt on its allowlisted public origin', () => {
  const first = new URL(yandexSearchUrl('продуктовый аналитик'));
  assert.equal(first.origin, 'https://yandex.ru');
  assert.equal(first.pathname, '/jobs/api/jobs/publications');
  assert.equal(first.searchParams.get('page_size'), '20');
  assert.equal(first.searchParams.get('text'), 'продуктовый аналитик');
  assert.equal(first.searchParams.get('cursor'), null);
  const next = new URL(yandexSearchUrl('аналитик', 'opaque cursor'));
  assert.equal(next.searchParams.get('cursor'), 'opaque cursor');
});

test('generic company detail normalization produces a complete deterministic vacancy', () => {
  const listing = yandexListingPage(yandexPayload).listings[0]!;
  const candidate: VacancyCandidate = {
    source: 'yandex', sourceId: listing.sourceId, url: listing.url, searchName: 'Продуктовая аналитика',
    title: listing.title, summary: listing.summary, publishedAt: '2026-08-06T10:00:00.000Z', payload: listing,
    listingHash: 'hash', status: 'normalizing', attempts: 1, combinedScore: 42,
  };
  const html = '<html><body><main><h1>Продуктовый аналитик в Телемост и Мессенджер</h1>'
    + '<p>Вам предстоит развивать продуктовые метрики и проводить исследования.</p>'
    + '<h2>Мы ждём, что вы</h2><ul><li>Работали аналитиком от 3 лет</li><li>Знаете SQL</li></ul>'
    + '</main><footer>Текст футера не относится к вакансии</footer></body></html>';
  assert.deepEqual(mainVacancyText(html), {
    title: listing.title,
    description: `${listing.title}\nВам предстоит развивать продуктовые метрики и проводить исследования.\nМы ждём, что вы\nРаботали аналитиком от 3 лет\nЗнаете SQL`,
  });
  const vacancy = companyVacancyInput(yandexCompanySite, candidate, html, candidate.url,
    yandexUrlPolicy.safeVacancyUrl);
  assert.ok(vacancy);
  assert.equal(vacancy.name, listing.title);
  assert.equal(vacancy.employer, 'Яндекс');
  assert.equal(vacancy.area, 'Москва, Санкт-Петербург');
  assert.equal(vacancy.experience.toLowerCase(), 'от 3 лет');
  assert.equal(vacancy.workFormat, 'Гибридный');
  assert.deepEqual(vacancy.keySkills, ['SQL', 'Python']);
  assert.equal(vacancy.publishedAt, candidate.publishedAt);
  assert.equal(vacancy.contentHash.length, 64);
  assert.ok(!vacancy.description.includes('Текст футера'));
  assert.equal(companyVacancyInput(yandexCompanySite, candidate, '<main><h1>Only a title</h1></main>', candidate.url,
    yandexUrlPolicy.safeVacancyUrl), null);
});

test('Yandex is registered through the common company-site VacancyPlatform and closed host allowlist', () => {
  const adapter = yandexSource();
  assert.equal(adapter.id, 'yandex');
  assert.equal(typeof adapter.discover, 'function');
  assert.equal(typeof adapter.normalize, 'function');
  assert.match(String(companyPlatform(yandexCompanySite).template().capabilities.query), /role title/i);
  assert.notEqual(yandexSource(), yandexSource(), 'the provider factory returns fresh provider instances');
  assert.equal(yandexUrlPolicy.sourceUrl('yandex', 'https://yandex.ru/jobs/vacancies/example-1').hostname, 'yandex.ru');
  assert.throws(() => yandexUrlPolicy.sourceUrl('yandex', 'https://jobs.s3.yandex.net/private'), /Unexpected/);
  assert.throws(() => yandexUrlPolicy.sourceUrl('yandex', 'https://example.com/jobs'), /Unexpected/);
});

test('a company definition registers without changing a central company id map', () => {
  const sources = createSources();
  sources.setProvider(createCompanySiteSource({
    ...yandexCompanySite,
    id: 'example-careers',
    name: 'Example Careers',
    employer: 'Example',
    hosts: ['careers.example.com'],
    searchUrl: (query) => `https://careers.example.com/jobs?q=${encodeURIComponent(query)}`,
  }));
  assert.equal(sources.getProvider('example-careers')?.name, 'Example Careers');
  assert.equal(sources.urlPolicy.sourceUrl('example-careers', 'https://careers.example.com/jobs/42').hostname,
    'careers.example.com');
  assert.throws(() => sources.urlPolicy.sourceUrl('example-careers', 'https://example.com/jobs/42'), /Unexpected/);
});
