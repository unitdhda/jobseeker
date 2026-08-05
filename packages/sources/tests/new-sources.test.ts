import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { postingMatchesQuery, configuredBoards, atsProviders } from '../src/ats.ts';
import { jsonLdBoards, boardPlatform } from '../src/boards.ts';
import { trudvsemVacancies, trudvsemVacancyInput, trudvsemSearchUrl } from '../src/trudvsem.ts';
import { getSearchPlatform, searchPlatformIds } from '../src/registry.ts';
import { sourceUrl } from '../src/http.ts';

test('new platforms are registered through the common vacancy-platform interface', () => {
  for (const id of ['geekjob', 'avito', 'trudvsem', 'ats']) {
    assert.ok(searchPlatformIds.includes(id), `${id} is not registered`);
    const platform = getSearchPlatform(id);
    assert.equal(typeof platform.discover, 'function');
    assert.equal(typeof platform.normalize, 'function');
    assert.ok(platform.template().rules.length > 0);
  }
});

test('new sources keep the per-source host allowlist closed', () => {
  assert.equal(sourceUrl('geekjob', 'https://geekjob.ru/vacancy/abc123').hostname, 'geekjob.ru');
  assert.throws(() => sourceUrl('geekjob', 'https://example.com/vacancy/abc123'), /Unexpected/);
  assert.throws(() => sourceUrl('avito', 'https://www.avito.ru/all/vakansii'), /Unexpected/);
  assert.throws(() => sourceUrl('trudvsem', 'http://trudvsem.ru/vacancy/card/1'), /Unsafe/);
  assert.equal(sourceUrl('ats', 'https://jobs.lever.co/acme/1').hostname, 'jobs.lever.co');
  assert.throws(() => sourceUrl('ats', 'https://evil.example/acme/1'), /Unexpected/);
});

test('ATS title matching requires every query word', () => {
  assert.ok(postingMatchesQuery('Senior Product Designer', 'product designer'));
  assert.ok(postingMatchesQuery('Staff Backend Engineer, Payments', 'backend engineer'));
  assert.ok(!postingMatchesQuery('Product Manager', 'product designer'));
  // Short tokens are dropped, so a query of only short words matches nothing rather than everything.
  assert.ok(!postingMatchesQuery('Anything at all', 'ai'));
});

test('ATS boards are configured per provider and reject malformed entries', () => {
  const boards = configuredBoards(['greenhouse:acme', 'lever:beta']);
  assert.deepEqual(boards.greenhouse, ['acme']);
  assert.deepEqual(boards.lever, ['beta']);
  assert.deepEqual(boards.ashby, []);
  assert.throws(() => configuredBoards(['unknown:acme']), /Unknown ATS provider/);
  assert.throws(() => configuredBoards(['greenhouse']), /provider:slug/);
});

test('JSON-LD board listings yield source ids, canonical urls, and real titles', () => {
  // Markup shapes below are taken from the live listings; the title is required because the candidate
  // prefilter scores on it and because neither board honours a text query.
  const geekjob = jsonLdBoards.geekjob.entries(
    '<p class="truncate vacancy-name"> <a href="/vacancy/6a70c39772d7eac1dc0fd403" target="_blank">Frontend-разработчик</a></p>'
    + '<time class="truncate datetime-info"><a href="/vacancy/6a70c39772d7eac1dc0fd403" target="_blank">4 августа</a> </time>'
    + '<a href="/vacancy/6a70c39772d7eac1dc0fd404">untitled link is ignored</a>',
    'https://geekjob.ru/vacancies');
  // GeekJob prints the date as Russian text with no year, so it is read back onto the most recent occurrence.
  assert.deepEqual([...geekjob].map(([id, entry]) => [id, entry.url, entry.title, entry.publishedAt?.slice(5, 10)]),
    [['6a70c39772d7eac1dc0fd403', 'https://geekjob.ru/vacancy/6a70c39772d7eac1dc0fd403', 'Frontend-разработчик', '08-04']]);
  const avito = jsonLdBoards.avito.entries(
    '<a href="/vacancies/prodazhi/19963/" class="vacancies-section__item-link"></a>'
    + '<a href="/vacancies/prodazhi/19963/" class="vacancies-section__item-name">Территориальный менеджер</a>',
    'https://career.avito.com/vacancies/');
  assert.deepEqual([...avito], [['19963',
    { url: 'https://career.avito.com/vacancies/prodazhi/19963/', title: 'Территориальный менеджер' }]]);
  // Both boards ignore text queries, so the listing address carries a page only.
  assert.equal(jsonLdBoards.geekjob.listing(1), 'https://geekjob.ru/vacancies');
  assert.equal(jsonLdBoards.geekjob.listing(2), 'https://geekjob.ru/vacancies?page=2');
  assert.equal(jsonLdBoards.avito.listing(2), 'https://career.avito.com/vacancies/?page=2');
  assert.ok(boardPlatform('avito').template().rules.some((rule) => /Russian/.test(rule)));
});

test('Работа России payloads normalize into vacancies without a second request', () => {
  const payload = {
    results: { vacancies: [{ vacancy: {
      id: 'd231fe14', 'job-name': 'Дизайнер', salary_min: 150000, salary_max: 0,
      duty: 'Разработка макетов материалов для банка во внутренних и внешних коммуникациях.',
      company: { name: 'РенКап Банк' }, region: { name: 'Город Москва' },
      schedule: 'Полный рабочий день', employment: 'Полная занятость',
      'creation-date': '2026-07-23', requirement: { experience: 3 },
      vac_url: 'https://trudvsem.ru/vacancy/card/7226c750/d231fe14',
    } }] },
  };
  const vacancies = trudvsemVacancies(payload);
  assert.equal(vacancies.length, 1);
  const vacancy = trudvsemVacancyInput(vacancies[0]!, 'Дизайнер');
  assert.ok(vacancy);
  assert.equal(vacancy.name, 'Дизайнер');
  assert.equal(vacancy.employer, 'РенКап Банк');
  assert.equal(vacancy.area, 'Город Москва');
  assert.equal(vacancy.salaryFrom, 150_000);
  assert.equal(vacancy.salaryTo, null, 'a zero maximum is absent, not a zero salary');
  assert.equal(vacancy.salaryCurrency, 'RUR');
  assert.equal(vacancy.experience, '3 лет');
  assert.ok(vacancy.contentHash.length === 64);
  // Postings without a usable description are rejected rather than stored as empty vacancies.
  assert.equal(trudvsemVacancyInput({ id: '1', 'job-name': 'X', duty: 'short' }, 'q'), null);
  assert.equal(trudvsemVacancies({ results: {} }).length, 0);
});

test('Работа России requests stay on the open API and page by offset', () => {
  const first = new URL(trudvsemSearchUrl('дизайнер', 1));
  assert.equal(first.hostname, 'opendata.trudvsem.ru');
  assert.equal(first.searchParams.get('limit'), '50');
  assert.equal(first.searchParams.get('offset'), null);
  assert.equal(new URL(trudvsemSearchUrl('дизайнер', 3)).searchParams.get('offset'), '100');
});
