import './toolkit-fixture.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { VacancyCandidate } from '@jobseeker/engine/contracts';
import { createSourceUrlPolicy } from '@jobseeker/sources';
import {
  ozonListingPage, ozonSearchUrl, ozonSource, ozonVacancyInput,
} from '../examples/ozon.ts';
import {
  rwbListingPage, rwbSearchUrl, rwbSource, rwbVacancyInput,
} from '../examples/rwb.ts';
import {
  mtsListingPage, mtsSearchUrl, mtsSource, mtsVacancyInput,
} from '../examples/mts.ts';
import {
  vkCompanySite, vkListingPage, vkSearchUrl, vkSource, vkVacancyInput,
} from '../examples/vk.ts';
import { konturBoard, konturSource } from '../examples/kontur.ts';
import {
  magnitListingPage, magnitSearchUrl, magnitSource, magnitVacancyInput,
} from '../examples/magnit.ts';
import {
  yadroListingPage, yadroSearchUrl, yadroSource, yadroVacancyInput,
} from '../examples/yadro.ts';
import {
  selectelListingPage, selectelSearchUrl, selectelSource, selectelVacancyInput,
} from '../examples/selectel.ts';
import {
  sberListingPage, sberSearchUrl, sberSource, sberVacancyInput,
} from '../examples/sber.ts';
import {
  kasperskyEntries, kasperskyFlightNames, kasperskySearchUrl, kasperskySource, kasperskyVacancyInput,
} from '../examples/kaspersky.ts';
import {
  tbankListings, tbankRequestBody, tbankSource, tbankVacancyFromHtml, tbankVacancyInput,
} from '../examples/tbank.ts';

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

test('MTS provider maps catalog listings, offsets, and detail sections', () => {
  const first = new URL(mtsSearchUrl('продуктовый дизайнер'));
  assert.equal(first.origin, 'https://job.mts.ru');
  assert.equal(first.pathname, '/api/v2/catalog/v1/vacancies');
  assert.equal(first.searchParams.get('q'), 'продуктовый дизайнер');
  assert.equal(first.searchParams.get('offset'), '0');

  const page = mtsListingPage({
    data: [{
      id: 'x6mibyccd0o8xmggfwodo7f3', slug: 'senior-c-developer-587926176983418922',
      title: 'Senior C++ Developer [MWS Cloud Platform]', externalUrl: 'https://job.mts.ru/jobs/587926176983418922',
      cities: [{ title: 'Москва' }], employer: { title: 'ООО МТС Веб Сервисы' },
      professionalRoles: [{ title: 'Работа в IT' }, { title: 'Backend' }],
      experience: { title: 'Более 6 лет' }, workFormats: [{ title: 'Удалённая работа' }],
      employmentForms: [{ title: 'Полный день' }], publishedAt: '2026-08-06T07:18:45.788Z', tags: [],
    }],
    meta: { pagination: { page: 1, pageSize: 20, pageCount: 3, total: 45 } },
  });
  assert.equal(page.nextCursor, '20');
  assert.deepEqual(page.listings, [{
    sourceId: 'x6mibyccd0o8xmggfwodo7f3',
    url: 'https://job.mts.ru/vacancy/587926176983418922',
    title: 'Senior C++ Developer [MWS Cloud Platform]',
    summary: 'Работа в IT · Backend · Москва · Более 6 лет · Удалённая работа',
    publishedAt: '2026-08-06T07:18:45.788Z',
    employer: 'ООО МТС Веб Сервисы', area: 'Москва', experience: 'Более 6 лет',
    employment: 'Полный день', workFormat: 'Удалённая работа', keySkills: [],
  }]);

  const provider = mtsSource();
  const policy = createSourceUrlPolicy([provider]);
  const input = mtsVacancyInput(
    candidate('mts', 'x6mibyccd0o8xmggfwodo7f3', page.listings[0]!.url, page.listings[0]),
    {
      data: {
        title: 'Senior C++ Developer [MWS Cloud Platform]', externalUrl: 'https://job.mts.ru/jobs/587926176983418922',
        descriptionAboutProject: 'Облачная платформа на собственных технологиях виртуализации.',
        description: 'Разрабатывать распределённые системы хранения данных.',
        requirements: 'Хорошо знать C++ и строить отказоустойчивые системы.',
        conditions: 'Собственная платформа для получения ИТ-ресурсов.',
        responsibilities: [], offers: [], advantages: [],
        cities: [{ title: 'Москва' }], employer: { title: 'ООО МТС Веб Сервисы' },
        experience: { title: 'Более 6 лет' }, workFormats: [{ title: 'Удалённая работа' }],
        employmentForms: [{ title: 'Полный день' }], tags: [{ title: 'C++' }],
        salary: { from: 400000, to: 0, currency: 'RUB', gross: true },
        publishedAt: '2026-08-06T07:18:45.788Z', isRemote: true,
      },
    },
    policy.safeVacancyUrl,
  );
  assert.ok(input);
  assert.equal(input.url, 'https://job.mts.ru/vacancy/587926176983418922');
  assert.equal(input.employer, 'ООО МТС Веб Сервисы');
  assert.equal(input.salaryFrom, 400_000);
  assert.equal(input.salaryTo, null);
  assert.equal(input.salaryCurrency, 'RUR');
  assert.equal(input.publishedAt, '2026-08-06T07:18:45.788Z');
  assert.match(input.description, /О проекте:/);
  assert.match(input.description, /Требования:/);
  assert.deepEqual(input.keySkills, ['C++']);
  assert.deepEqual(provider.hosts, ['job.mts.ru']);
  assert.notEqual(mtsSource(), mtsSource());
});

test('VK provider filters by title and reads the itemprop vacancy body', () => {
  const first = new URL(vkSearchUrl('дизайнер'));
  assert.equal(first.origin, 'https://team.vk.company');
  assert.equal(first.pathname, '/career/api/v2/vacancies/');
  assert.equal(first.searchParams.get('title'), 'дизайнер');
  assert.equal(first.searchParams.get('offset'), '0');
  assert.equal(first.searchParams.get('search'), null);

  const page = vkListingPage({
    count: 45,
    // The API advertises its own internal http:// origin; only the offset may be reused.
    next: 'http://team.vk.company/career/api/v2/vacancies/?limit=20&offset=20&title=%D0%B4%D0%B8%D0%B7%D0%B0%D0%B9%D0%BD%D0%B5%D1%80',
    results: [{
      id: 52565, title: 'Ведущий специалист технической поддержки', town: { name: 'Москва' },
      group: { name: 'MAX' }, prof_area: { name: 'Внутренние сервисы' }, specialty: { name: 'Поддержка' },
      work_format: 'Офисный', remote: false, tags: [{ name: 'helpdesk' }],
    }],
  });
  assert.equal(page.nextCursor, '20');
  assert.equal(page.listings.length, 1);
  assert.equal(page.listings[0]!.url, 'https://team.vk.company/vacancy/52565/');
  assert.equal(page.listings[0]!.summary, 'MAX · Внутренние сервисы · Поддержка · Москва · Офисный');
  assert.deepEqual(page.listings[0]!.keySkills, ['helpdesk']);
  assert.equal(new URL(vkSearchUrl('дизайнер', page.nextCursor)).searchParams.get('offset'), '20');

  const provider = vkSource();
  const policy = createSourceUrlPolicy([provider]);
  const html = `<h1 class="title-main mobile-only">Заголовок для мобильных</h1>
    <div itemprop="title" class="title desktop-only">Ведущий специалист технической поддержки</div>
    <div class="article" itemprop="description">
      <p>Поддерживаем ключевых пользователей мессенджера.</p>
      <h3>Задачи</h3><ul><li>Диагностировать инциденты по логам</li></ul>
    </div>
    <div class="page-control"><a href="#">Откликнуться</a></div>`;
  const input = vkVacancyInput(
    candidate('vk', '52565', page.listings[0]!.url, page.listings[0]),
    html, 'https://team.vk.company/vacancy/52565/', policy.safeVacancyUrl,
  );
  assert.ok(input);
  assert.equal(input.name, 'Ведущий специалист технической поддержки');
  assert.equal(input.employer, 'VK');
  assert.equal(input.area, 'Москва');
  assert.equal(input.url, 'https://team.vk.company/vacancy/52565/');
  assert.match(input.description, /Диагностировать инциденты/);
  assert.doesNotMatch(input.description, /Откликнуться/);
  assert.deepEqual(provider.hosts, ['team.vk.company']);
  assert.deepEqual(vkCompanySite.hosts, ['team.vk.company']);
  assert.notEqual(vkSource(), vkSource());
});

test('Kontur board enumerates its single listing page and keeps real titles', () => {
  assert.equal(konturBoard.listing(1), 'https://kontur.ru/career/vacancies');
  assert.equal(konturBoard.listing(2), konturBoard.listing(1));

  const entries = konturBoard.entries(`
    <a class="vacancy" href="/career/vacancies/3728" data-event-name="career-vacancies-click-development-3728">
      <span href="/career/vacancies/3728" class="vacancy__title">Руководитель команды разработки</span>&nbsp;
      <div class="vacancy__description"><span>Санкт-Петербург и ещё 8 городов</span></div>
    </a>
    <a class="vacancy" href="/career/vacancies/5811" data-event-name="career-vacancies-click-support-5811">
      <span class="vacancy__title">Ведущий специалист сопровождения</span>
    </a>
    <a class="promo" href="/career/vacancies/conditions"><span>Условия работы</span></a>`,
  'https://kontur.ru/career/vacancies');
  assert.deepEqual([...entries.keys()], ['3728', '5811']);
  assert.deepEqual(entries.get('3728'), {
    url: 'https://kontur.ru/career/vacancies/3728', title: 'Руководитель команды разработки',
  });

  const provider = konturSource();
  assert.deepEqual(provider.hosts, ['kontur.ru']);
  assert.equal(provider.enumerates, true);
  assert.notEqual(konturSource(), konturSource());
});

test('Magnit provider maps API pages and joins detail sections', () => {
  const first = new URL(magnitSearchUrl('аналитик'));
  assert.equal(first.origin, 'https://magnit.tech');
  assert.equal(first.pathname, '/api/v1/vacancy');
  assert.equal(first.searchParams.get('search'), 'аналитик');
  assert.equal(first.searchParams.get('page'), '1');

  const page = magnitListingPage({
    success: true,
    meta: { current_page: 1, has_more_pages: true, total: 55 },
    results: [{
      id: 2741, foreign_id: 7046, title: 'Разработчик Fullstack Vue.JS + WebTutor', location: 'Россия',
      direction: { name: 'Корпоративные IT-системы' }, speciality: { name: 'Fullstack' },
      work_formats: [{ name: 'Москва и Краснодар (гибрид/офис), другие города - удаленно' }],
      technologies: [{ name: 'JavaScript' }, { name: 'SQL' }],
    }],
  });
  assert.equal(page.nextCursor, '2');
  assert.equal(page.listings[0]!.url, 'https://magnit.tech/vacancies/2741');
  assert.equal(page.listings[0]!.summary,
    'Корпоративные IT-системы · Fullstack · Россия · Москва и Краснодар (гибрид/офис), другие города - удаленно');
  assert.deepEqual(page.listings[0]!.keySkills, ['JavaScript', 'SQL']);

  const provider = magnitSource();
  const policy = createSourceUrlPolicy([provider]);
  const input = magnitVacancyInput(
    candidate('magnit', '2741', page.listings[0]!.url, page.listings[0]),
    {
      success: true,
      results: {
        id: 2741, title: 'Разработчик Fullstack Vue.JS + WebTutor', location: 'Россия',
        description: '<p>Мы в поиске талантливого Fullstack разработчика.</p>',
        tasks: '<ul><li>Разрабатывать бизнес-логику</li></ul>',
        skills: '<ul><li>Опыт Vue3 от 3 лет</li></ul>',
        extra_skills: '<p>Опыт работы с WebTutor.</p>', offer: '<ul><li>ДМС</li></ul>', about_product: null,
        work_formats: [{ name: 'Гибрид' }], technologies: [{ name: 'Vue.js' }],
      },
    },
    policy.safeVacancyUrl,
  );
  assert.ok(input);
  assert.equal(input.url, 'https://magnit.tech/vacancies/2741');
  assert.equal(input.employer, 'Магнит Tech');
  assert.match(input.description, /Задачи:/);
  assert.match(input.description, /Будет плюсом:/);
  assert.equal(input.workFormat, 'Гибрид');
  assert.deepEqual(input.keySkills, ['Vue.js']);
  assert.deepEqual(provider.hosts, ['magnit.tech']);
  assert.notEqual(magnitSource(), magnitSource());
});

test('YADRO provider normalizes complete listings without a detail request', () => {
  const first = new URL(yadroSearchUrl('инженер'));
  assert.equal(first.origin, 'https://careers.yadro.com');
  assert.equal(first.pathname, '/api/v1/vacancies/');
  assert.equal(first.searchParams.get('search'), 'инженер');
  assert.equal(first.searchParams.get('offset'), '0');

  const page = yadroListingPage({
    count: 126,
    // The API's own next link is plain http; only the offset survives.
    next: 'http://careers.yadro.com/api/v1/vacancies/?limit=20&offset=20&search=%D0%B8%D0%BD%D0%B6%D0%B5%D0%BD%D0%B5%D1%80',
    results: [{
      id: 318, slug: 63532, title: 'Инженер по автоматизации тестирования (AQA Python)',
      description: '<p><b>Чем предстоит заниматься:</b></p><ul><li>Автоматизировать тестирование</li></ul>',
      city: [{ name: 'Нижний Новгород' }], country: [{ name: 'Россия' }],
      direction: { name: 'IT и разработка продуктов' }, specialization: { name: 'Тестирование' },
      team: { name: 'Telecom' }, grade: [{ name: 'Специалист' }, { name: 'Старший' }],
      empl: [{ name: 'Гибридный' }, { name: 'Работа в офисе' }],
      skill: [{ name: 'AQA' }, { name: 'Python' }],
    }],
  });
  assert.equal(page.nextCursor, '20');
  assert.equal(page.listings[0]!.url, 'https://careers.yadro.com/vacancy/63532');
  assert.equal(page.listings[0]!.summary,
    'IT и разработка продуктов · Тестирование · Telecom · Нижний Новгород · Специалист, Старший · Гибридный, Работа в офисе');
  assert.equal(new URL(yadroSearchUrl('инженер', page.nextCursor)).searchParams.get('offset'), '20');

  const provider = yadroSource();
  const policy = createSourceUrlPolicy([provider]);
  const input = yadroVacancyInput(
    candidate('yadro', '318', page.listings[0]!.url, page.listings[0]), policy.safeVacancyUrl);
  assert.ok(input);
  assert.equal(input.name, 'Инженер по автоматизации тестирования (AQA Python)');
  assert.equal(input.employer, 'YADRO');
  assert.equal(input.area, 'Нижний Новгород');
  assert.equal(input.experience, 'Специалист, Старший');
  assert.match(input.description, /Автоматизировать тестирование/);
  assert.deepEqual(input.keySkills, ['AQA', 'Python']);
  assert.equal(input.url, 'https://careers.yadro.com/vacancy/63532');
  assert.deepEqual(provider.hosts, ['careers.yadro.com']);
  assert.notEqual(yadroSource(), yadroSource());
});

test('Selectel provider enumerates the catalogue and matches titles locally', () => {
  const url = new URL(selectelSearchUrl());
  assert.equal(url.origin, 'https://api.selectel.ru');
  assert.equal(url.pathname, '/proxy/public/employee/api/public/vacancies');
  // No text search exists, so the query never leaves the process.
  assert.equal(url.searchParams.get('search'), null);

  const payload = {
    item_count: 12, page: 1, page_count: 1,
    items: [{
      id: 1580, title: 'MLOps инженер', is_hot: false, is_remote_available: true,
      published_at: '2026-08-06T08:52:37.966066+03:00',
      city: { name: 'Санкт-Петербург' }, tag: { name: 'ml', description: 'Machine Learning' },
      timetable_mode: { name: 'Гибкий' },
    }, {
      id: 1839, title: 'Руководитель проектов по общестроительным работам', is_remote_available: false,
      city: { name: 'Москва' }, tag: { description: 'Строительство' }, timetable_mode: { name: 'Фиксированный' },
    }],
  };
  const search = { name: 'ML', rationale: 'smoke', query: 'MLOps инженер' };
  const matched = selectelListingPage(payload, search);
  assert.equal(matched.listings.length, 1);
  assert.equal(matched.listings[0]!.url, 'https://selectel.ru/careers/all/vacancy/1580/');
  assert.equal(matched.listings[0]!.publishedAt, '2026-08-06T08:52:37.966066+03:00');
  assert.equal(matched.listings[0]!.summary, 'Machine Learning · Санкт-Петербург · Гибкий · Удалённо доступно');
  assert.equal((matched as { nextCursor?: string }).nextCursor, undefined);

  const provider = selectelSource();
  const policy = createSourceUrlPolicy([provider]);
  const input = selectelVacancyInput(
    candidate('selectel', '1580', matched.listings[0]!.url, matched.listings[0]),
    {
      id: 1580, title: 'MLOps инженер', is_remote_available: true,
      short_desc: '<p>Развиваем ML-платформу для клиентов облака.</p>',
      detailed_desc: '<strong>Основные задачи</strong><ul><li>Автоматизировать пайплайны обучения</li></ul>',
      conditions: '<ul><li>ДМС</li></ul>',
      city: { name: 'Санкт-Петербург' }, timetable_mode: { name: 'Гибкий' },
      published_at: '2026-08-06T08:52:37.966066+03:00',
    },
    policy.safeVacancyUrl,
  );
  assert.ok(input);
  assert.equal(input.employer, 'Selectel');
  assert.equal(input.area, 'Санкт-Петербург');
  assert.equal(input.employment, 'Гибкий');
  assert.equal(input.workFormat, 'Удалённо доступно');
  assert.equal(input.publishedAt, '2026-08-06T08:52:37.966066+03:00');
  assert.match(input.description, /Автоматизировать пайплайны/);
  assert.match(input.description, /ДМС/);
  assert.equal(input.url, 'https://selectel.ru/careers/all/vacancy/1580/');
  assert.deepEqual(provider.hosts, ['api.selectel.ru', 'selectel.ru']);
  assert.notEqual(selectelSource(), selectelSource());
});

test('Sber provider paginates by skip and normalizes complete markdown listings', () => {
  const first = new URL(sberSearchUrl('дизайнер'));
  assert.equal(first.origin, 'https://rabota.sber.ru');
  assert.equal(first.pathname, '/public/app-candidate-public-api-gateway/api/v1/publications');
  assert.equal(first.searchParams.get('searchString'), 'дизайнер');
  assert.equal(first.searchParams.get('skip'), '0');

  const page = sberListingPage({
    success: true,
    data: {
      total: 51,
      vacancies: [{
        internalId: 4550566, requisitionId: 'a64d9ef6', title: 'Дизайнер коммуникаций в GigaCode',
        company: 'АО "СберТех"', city: 'г Москва', region: '', specialization: 'Информационные технологии:Дизайнер',
        publicationDate: '2026-08-06T14:01:15.000Z', salary_min: 200000, salary_max: null,
        introduction: 'GigaCode — AI-ассистент для разработчиков.',
        duties: '### Обязанности:\n\n* оформлять презентации',
        requirements: '### Требования:\n\n* сильный навык визуальной коммуникации',
        conditions: '### **Мы предлагаем:**\n\n* годовой бонус',
      }],
    },
  }, 20);
  assert.equal(page.nextCursor, '40');
  assert.equal(page.listings[0]!.url, 'https://rabota.sber.ru/search/vacancy-4550566/');
  assert.equal(page.listings[0]!.publishedAt, '2026-08-06T14:01:15.000Z');
  assert.equal(page.listings[0]!.employer, 'АО "СберТех"');

  const provider = sberSource();
  const policy = createSourceUrlPolicy([provider]);
  const input = sberVacancyInput(
    candidate('sber', '4550566', page.listings[0]!.url, page.listings[0]), policy.safeVacancyUrl);
  assert.ok(input);
  assert.equal(input.employer, 'АО "СберТех"');
  assert.equal(input.area, 'г Москва');
  assert.equal(input.salaryFrom, 200_000);
  assert.equal(input.salaryCurrency, 'RUR');
  assert.match(input.description, /Обязанности/);
  assert.match(input.description, /Мы предлагаем/);
  assert.deepEqual(provider.hosts, ['rabota.sber.ru']);
  assert.notEqual(sberSource(), sberSource());
});

test('Kaspersky provider reads server-rendered search anchors and RSC names', () => {
  const url = new URL(kasperskySearchUrl('инженер'));
  assert.equal(url.pathname, '/vacancies/search');
  assert.equal(url.searchParams.get('q'), 'инженер');

  const entries = kasperskyEntries(`
    <a href="/vacancy/25116"><span class="relative z-20">System Engineer (Ceph)</span></a>
    <a href="/vacancy/25718">DevOps Engineer (IDP)</a>
    <a href="/vacancy/25116"><span>System Engineer (Ceph)</span></a>
    <a href="/vacancies?category=32630"><span data-testid="vacancy-tag">Системное администрирование</span></a>`);
  assert.deepEqual(entries, [
    { sourceId: '25116', url: 'https://careers.kaspersky.ru/vacancy/25116', title: 'System Engineer (Ceph)' },
    { sourceId: '25718', url: 'https://careers.kaspersky.ru/vacancy/25718', title: 'DevOps Engineer (IDP)' },
  ]);

  // The page embeds vacancy JSON inside a JS string, so quotes arrive backslash-escaped exactly like this.
  const flight = `self.__next_f.push([1,${JSON.stringify('34:' + JSON.stringify({ rootVacancy: {
    jobReqId: '25116',
    cities: [{ code: '25373', name: 'Москва', engName: 'Moscow' }],
    skills: [{ code: '33000', name: 'Linux' }, { code: '33020', name: 'Windows' }],
  } }))}])`;
  assert.deepEqual(kasperskyFlightNames(flight, 'cities'), ['Москва']);
  assert.deepEqual(kasperskyFlightNames(flight, 'skills'), ['Linux', 'Windows']);

  const provider = kasperskySource();
  const policy = createSourceUrlPolicy([provider]);
  const html = `<h1>System Engineer (Ceph)</h1><main><p>Поддерживать и развивать кластеры Ceph в проде.</p></main>${flight}`;
  const input = kasperskyVacancyInput(
    candidate('kaspersky', '25116', 'https://careers.kaspersky.ru/vacancy/25116', { sourceId: '25116' }),
    html, 'https://careers.kaspersky.ru/vacancy/25116', policy.safeVacancyUrl);
  assert.ok(input);
  assert.equal(input.name, 'System Engineer (Ceph)');
  assert.equal(input.employer, 'Лаборатория Касперского');
  assert.equal(input.area, 'Москва');
  assert.deepEqual(input.keySkills, ['Linux', 'Windows']);
  assert.deepEqual(provider.hosts, ['careers.kaspersky.ru']);
  assert.notEqual(kasperskySource(), kasperskySource());
});

test('T-Bank provider enumerates the RPC gateway and reads the SSR state blob', () => {
  const body = JSON.parse(tbankRequestBody('tcareer_it', 'it', 10));
  assert.equal(body.filters.generatedGraphQL.type, 'T_CAREER');
  assert.deepEqual(body.filters.generatedGraphQL.or, [{ category: 'tcareer_it' }]);
  assert.deepEqual(body.pagination, { it: { offset: 10, isFinished: false } });

  const page = tbankListings({
    resultCode: 'OK',
    payload: {
      vacancies: [{
        title: 'Продуктовый аналитик (B2B-кредитование)', subtitle: 'Москва', category: 'tcareer_it',
        shortDescription: 'Развивайте продукты кредитования бизнеса', salary: null,
        tags: ['Гибрид', 'Middle'], urlSlug: 'baaff85a-3b03', seoSlug: 'produktovyj-analitik',
        source: 'publisher', redirectUrl: null,
      }, {
        title: 'Redirected elsewhere', urlSlug: 'x', seoSlug: 'x', redirectUrl: 'https://elsewhere.example',
      }],
      nextPagination: { it: { offset: 10, isFinished: false, totalCount: 246 } },
    },
  }, 'it');
  assert.equal(page.nextOffset, 10);
  assert.equal(page.listings.length, 1);
  assert.equal(page.listings[0]!.url,
    'https://www.tbank.ru/career/service/vacancy/moscow/produktovyj-analitik/baaff85a-3b03/');
  assert.equal(page.listings[0]!.workFormat, 'Гибрид, Middle');

  const state = JSON.stringify({
    stores: {
      vacancyDescriptionStore: {
        vacancyDescription: {
          title: 'Продуктовый аналитик (B2B-кредитование)', subtitle: 'Москва', status: 'published',
          salary: { amount: null }, tags: [{ text: 'Гибрид' }, { text: 'Middle' }],
          description: [
            { title: 'Подзаголовок (короткое описание)', key: 'shortDescription', content: '<ul><li>Гибкая система</li></ul>' },
            { title: 'Обязанности', content: [{ title: null, description: 'Строить аналитику кредитования' }] },
            { title: 'Мы ждем от вас', content: [{ title: 'Опыт', description: 'SQL и Python' }] },
          ],
        },
      },
    },
    padding: 'x'.repeat(2100),
  });
  const html = `<html><script>small</script><script>${state}</script></html>`;
  const vacancy = tbankVacancyFromHtml(html);
  assert.ok(vacancy);

  const provider = tbankSource();
  assert.equal(provider.enumerates, true);
  const policy = createSourceUrlPolicy([provider]);
  const input = tbankVacancyInput(
    candidate('tbank', 'baaff85a-3b03', page.listings[0]!.url, page.listings[0]), html, policy.safeVacancyUrl);
  assert.ok(input);
  assert.equal(input.name, 'Продуктовый аналитик (B2B-кредитование)');
  assert.equal(input.area, 'Москва');
  assert.equal(input.workFormat, 'Гибрид, Middle');
  assert.match(input.description, /Обязанности:/);
  assert.match(input.description, /Опыт: SQL и Python/);
  assert.doesNotMatch(input.description, /короткое описание/);
  assert.deepEqual(provider.hosts, ['www.tbank.ru']);
  assert.notEqual(tbankSource(), tbankSource());
});
