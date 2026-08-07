import assert from 'node:assert/strict';
import test from 'node:test';
import { en } from '../src/i18n/en.ts';
import { ru } from '../src/i18n/ru.ts';
import { isLocale, locales, normalizeLocale } from '../src/i18n/locale.ts';
import { digestPageMessage, salary, searchProfileMessage, userStatusText } from '../src/telegram/format.ts';
import { userWorkflowBusyMessage } from '../src/telegram/workflow-lock.ts';
import type { ScoredVacancy } from '@jobseeker/store';

const catalogues = { ru, en };

type Shape = { [key: string]: string | Shape };
/** A message is described by its kind and, for a function, how many values it interpolates. */
function shapeOf(value: object): Shape {
  const shape: Shape = {};
  for (const [key, entry] of Object.entries(value)) {
    shape[key] = typeof entry === 'function' ? `function/${entry.length}`
      : entry && typeof entry === 'object' ? shapeOf(entry) : typeof entry;
  }
  return shape;
}
function leaves(value: object, path = ''): [string, unknown][] {
  return Object.entries(value).flatMap(([key, entry]) => entry && typeof entry === 'object'
    ? leaves(entry, `${path}${key}.`) : [[`${path}${key}`, entry] as [string, unknown]]);
}

test('every locale carries the same messages with the same interpolated values', () => {
  // The English catalogue is typed against the Russian one, so this guards what types cannot: a translator
  // dropping a parameter, or a source that only one language knows how to name.
  assert.deepEqual(shapeOf(en), shapeOf(ru));
});

test('a locale is complete: no message is left empty or untranslated', () => {
  for (const [locale, catalogue] of Object.entries(catalogues)) {
    for (const [path, value] of leaves(catalogue)) {
      if (typeof value !== 'string') continue;
      assert.ok(value.trim().length > 0, `${locale}.${path} is empty`);
    }
  }
});

test('the English catalogue is actually English', () => {
  const cyrillic = leaves(en).filter(([, value]) => typeof value === 'string' && /[Ѐ-ӿ]/u.test(value));
  assert.deepEqual(cyrillic.map(([path]) => path), [], 'English messages must not contain Cyrillic text');
});

test('client language tags resolve to a catalogue we have, and nothing else', () => {
  assert.equal(normalizeLocale('en'), 'en');
  assert.equal(normalizeLocale('en-GB'), 'en');
  assert.equal(normalizeLocale('RU'), 'ru');
  assert.equal(normalizeLocale('ru_RU'), 'ru');
  // An untranslated client language is not half-served; the caller falls back to the deployment default.
  assert.equal(normalizeLocale('de-AT'), null);
  assert.equal(normalizeLocale(undefined), null);
  assert.equal(normalizeLocale(''), null);
  assert.equal(normalizeLocale('  '), null);
  for (const locale of locales) assert.ok(isLocale(locale));
  assert.ok(!isLocale('de'));
});

function vacancy(overrides: Partial<ScoredVacancy> = {}): ScoredVacancy {
  return { id: 1, source: 'hh', sourceId: '1', applyId: 'aabbcc', name: 'Backend Engineer', employer: 'Employer',
    area: 'Area', salaryFrom: null, salaryTo: null, salaryCurrency: null, salaryGross: null, experience: '',
    employment: '', schedule: '', workFormat: '', description: '', keySkills: [], url: 'https://hh.ru/vacancy/1',
    publishedAt: '2026-08-05T00:00:00Z', sourceQuery: '', contentHash: '', decision: 'scored', userId: 'u1',
    score: 91, ...overrides };
}

test('user-facing text follows the locale it is rendered for', () => {
  const digest = (locale: 'ru' | 'en') => digestPageMessage([vacancy()], ['aabbcc'], 0, 2, locale).text;
  assert.match(digest('ru'), /Ежедневная подборка вакансий/u);
  assert.match(digest('en'), /Daily vacancy digest/u);
  assert.doesNotMatch(digest('en'), /[Ѐ-ӿ]/u);

  assert.equal(userStatusText('pending', 'ru'), 'на рассмотрении');
  assert.equal(userStatusText('pending', 'en'), 'awaiting a decision');

  const busy = userWorkflowBusyMessage(null, 'cover-letter', 'en');
  assert.match(busy, /another CV or document task/u);
  assert.match(busy, /cover letter/u);
  assert.doesNotMatch(busy, /[Ѐ-ӿ]/u);

  const profile = { filename: 'cv.pdf', tracks: ['Backend'], platforms: [{ label: 'HH', terms: ['backend'] }] };
  assert.match(searchProfileMessage(profile, 'en'), /Queries: 1 across 1 platforms/u);
});

test('numbers and salaries are formatted for the reader, not for one hardcoded locale', () => {
  const paid = vacancy({ salaryFrom: 250_000, salaryTo: 400_000, salaryCurrency: 'RUR', salaryGross: false });
  // Same figures, each locale's own grouping and wording.
  assert.match(salary(paid, 'ru'), /^250\s?000–400\s?000 RUR на руки$/u);
  assert.match(salary(paid, 'en'), /^250,000–400,000 RUR net$/u);
  assert.equal(salary(vacancy({ salaryFrom: 1_000 }), 'en'), 'from 1,000');
  assert.equal(salary(vacancy(), 'en'), 'not stated');
  assert.equal(salary(vacancy(), 'ru'), 'не указана');
});
