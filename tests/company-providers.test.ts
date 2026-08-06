import assert from 'node:assert/strict';
import test from 'node:test';
import type { VacancyCandidate } from '@jobseeker/engine/contracts';
import { createSourceUrlPolicy } from '@jobseeker/sources';
import {
  ozonListingPage, ozonSearchUrl, ozonSource, ozonVacancyInput,
} from '../src/vacancies/providers/ozon.ts';
import {
  rwbListingPage, rwbSearchUrl, rwbSource, rwbVacancyInput,
} from '../src/vacancies/providers/rwb.ts';

function candidate(source: string, sourceId: string, url: string, payload: unknown): VacancyCandidate {
  return {
    source, sourceId, url, searchName: 'Product design', title: 'Fallback title', summary: '',
    publishedAt: '2026-08-06T10:00:00.000Z', payload, listingHash: 'hash', status: 'normalizing',
    attempts: 1, combinedScore: null,
  };
}

test('Ozon provider maps public API listings, pagination, and details', () => {
  const first = new URL(ozonSearchUrl('продуктовый дизайнер'));
  assert.equal(first.origin, 'https://job-api.ozon.ru');
  assert.equal(first.pathname, '/vacancy');
  assert.equal(first.searchParams.get('query'), 'продуктовый дизайнер');
  assert.equal(first.searchParams.get('page'), '1');

  const page = ozonListingPage({
    items: [{
      hhId: 132655368, title: 'Junior Data Engineer', city: 'Москва', department: 'Ozon Tech', hidden: false,
      employment: 'Полная', experience: 'От 1 года до 3 лет', workFormat: ['Гибрид'],
      professionalRoles: [{ ID: '165', title: 'Дата-сайентист' }],
    }, { hhId: 9, title: 'Hidden', hidden: true }],
    meta: { page: 1, totalPages: 3 },
  });
  assert.equal(page.nextCursor, '2');
  assert.deepEqual(page.listings, [{
    sourceId: '132655368', url: 'https://job-api.ozon.ru/vacancy/132655368',
    title: 'Junior Data Engineer',
    summary: 'Ozon Tech · Дата-сайентист · Москва · От 1 года до 3 лет · Гибрид',
    area: 'Москва', experience: 'От 1 года до 3 лет', employment: 'Полная', workFormat: 'Гибрид',
  }]);

  const provider = ozonSource();
  const policy = createSourceUrlPolicy([provider]);
  const input = ozonVacancyInput(candidate('ozon', '132655368', page.listings[0]!.url, page.listings[0]), {
    name: 'Junior Data Engineer', city: 'Москва', exp: 'От 1 года до 3 лет', employment: 'Полная',
    descr: '<p>Автоматизировать отчёты и развивать надёжные конвейеры обработки данных.</p>',
    skills: [{ name: 'SQL' }, { name: 'Python' }], workFormat: ['Гибрид'],
    salary: { from: 0, to: 0, currency: '', gross: false },
    publishedAt: '2026-07-31 13:14:34', slug: 'junior-data-engineer-132655368',
  }, policy.safeVacancyUrl);
  assert.ok(input);
  assert.equal(input.url, 'https://career.ozon.ru/vacancy/junior-data-engineer-132655368');
  assert.equal(input.publishedAt, '2026-07-31T10:14:34.000Z');
  assert.deepEqual(input.keySkills, ['SQL', 'Python']);
  assert.equal(input.contentHash.length, 64);
  assert.deepEqual(provider.hosts, ['job-api.ozon.ru', 'career.ozon.ru']);
  assert.notEqual(ozonSource(), ozonSource());
});

test('RWB provider maps public API listings, offsets, and details', () => {
  const first = new URL(rwbSearchUrl('Data Engineer'));
  assert.equal(first.origin, 'https://career.rwb.ru');
  assert.equal(first.pathname, '/crm-api/api/v1/pub/vacancies');
  assert.equal(first.searchParams.get('title'), 'Data Engineer');
  assert.equal(first.searchParams.get('offset'), '0');

  const page = rwbListingPage({
    status: 200,
    data: {
      items: [{
        id: 29074, name: 'Data Scientist в команду Поиска', direction_title: 'Data science',
        direction_role_title: 'Data Scientist', experience_type_title: 'От 3 лет', city_title: 'Москва',
        employment_types: [{ title: 'Гибрид' }, { title: 'Удаленно' }],
      }],
      range: { count: 45, limit: 20, offset: 0 },
    },
  });
  assert.equal(page.nextCursor, '20');
  assert.deepEqual(page.listings, [{
    sourceId: '29074', url: 'https://career.rwb.ru/vacancies/29074',
    title: 'Data Scientist в команду Поиска',
    summary: 'Data science · Data Scientist · Москва · От 3 лет · Гибрид · Удаленно',
    area: 'Москва', experience: 'От 3 лет', employment: '', workFormat: 'Гибрид, Удаленно',
  }]);

  const provider = rwbSource();
  const policy = createSourceUrlPolicy([provider]);
  const input = rwbVacancyInput(candidate('rwb', '29074', page.listings[0]!.url, page.listings[0]), {
    status: 200,
    data: {
      name: 'Data Scientist в команду Поиска', description: 'Развивать поиск и алгоритмы ранжирования.',
      office_location_city_title: 'Москва', experience_type_title: 'От 3 лет', salary_from: null,
      employment_types_list: [{ title: 'Гибрид' }, { title: 'Удаленно' }],
      duties_arr: ['Проводить эксперименты.'], requirements_arr: ['Знать Python.'],
      conditions_arr: ['ДМС.'], skill_types_list: [{ name: 'Python' }],
    },
  }, policy.safeVacancyUrl);
  assert.ok(input);
  assert.equal(input.url, 'https://career.rwb.ru/vacancies/29074');
  assert.match(input.description, /Обязанности:/);
  assert.deepEqual(input.keySkills, ['Python']);
  assert.equal(input.contentHash.length, 64);
  assert.deepEqual(provider.hosts, ['career.rwb.ru']);
  assert.notEqual(rwbSource(), rwbSource());
});
