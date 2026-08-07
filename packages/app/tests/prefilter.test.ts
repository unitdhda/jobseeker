import assert from 'node:assert/strict';
import test from 'node:test';
import { careerProfileSchema, prefilterVacancy, vacancyRecency, type CareerProfile } from '@jobseeker/engine';
import type { Vacancy } from '@jobseeker/store';
import * as v from 'valibot';
import { textSearchProfileSchema } from '@jobseeker/sources/examples/habr';

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

function vacancy(name: string, description: string, keySkills: string[] = [], publishedAt = daysAgo(0)): Vacancy {
  return { id: 1, source: 'hh', sourceId: '1', applyId: 'aaaaaa', name, employer: 'Employer', area: 'Remote',
    salaryFrom: null, salaryTo: null, salaryCurrency: null, salaryGross: null, experience: '', employment: '', schedule: '',
    workFormat: '', description, keySkills, url: 'https://hh.ru/vacancy/1', publishedAt, sourceQuery: name,
    contentHash: 'hash', decision: 'new' };
}

const designerCv = `Arseniy is an art director and communication designer.\nProduct design lead\nBrand identity, visual campaigns, landing pages.\nContacts: telegram developer_friend`;
const designerProfile: CareerProfile = { version: 1, tracks: [
  { name: 'Communication design', titleVariants: ['communication designer', 'коммуникационный дизайнер'],
    coreSkills: ['brand identity', 'visual campaigns'], evidence: ['communication designer'] },
  { name: 'Product design leadership', titleVariants: ['product design lead', 'дизайн-лид'],
    coreSkills: ['product design', 'design leadership'], evidence: ['Product design lead'] },
] };

await test('CV-derived prefilter has no software-role bonus', () => {
  const unrelated = prefilterVacancy(designerCv,
    vacancy('Senior Fullstack Developer', 'Build backend services with TypeScript. Contact us in Telegram.', ['TypeScript']),
    20, designerProfile);
  assert.equal(unrelated.filtered, true);
  assert.ok(unrelated.combinedScore < 20);
  assert.equal(unrelated.reasons.some((reason) => reason.includes('software-role title')), false);

  const relevant = prefilterVacancy(designerCv,
    vacancy('Senior Communication Designer', 'Create brand identity and visual campaigns.', ['Brand identity']),
    20, designerProfile);
  assert.equal(relevant.filtered, false);
  assert.ok(relevant.regexScore > unrelated.regexScore);
});

await test('career profile format requires translations as separate title variants', () => {
  const combined = { version: 1, tracks: [{ name: 'Product design', titleVariants: ['Продуктовый дизайнер / Product Designer'],
    coreSkills: ['Продуктовый дизайн'], evidence: ['CV'] }] };
  assert.equal(v.safeParse(careerProfileSchema,combined).success,false);
  assert.equal(v.safeParse(careerProfileSchema,{ ...combined,tracks: [{ ...combined.tracks[0],
    titleVariants: ['Продуктовый дизайнер','Product Designer'] }] }).success,true);
});

await test('legacy bilingual title variants are compared defensively as separate titles', () => {
  const profile: CareerProfile = { version: 1, tracks: [{ name: 'Product design',
    titleVariants: ['Продуктовый дизайнер / Product Designer'], coreSkills: ['Продуктовый дизайн'], evidence: ['CV'] }] };
  const result = prefilterVacancy('Продуктовый дизайнер. Продуктовый дизайн.',
    vacancy('Продуктовый дизайнер', 'Продуктовый дизайн.'), 20, profile);
  assert.equal(result.filtered, false);
  assert.equal(result.reasons.includes('title-variant similarity: 1.000'),true);
  assert.ok(result.regexScore >= 75);
});

await test('the same generic model supports non-design occupations', () => {
  const accountantProfile: CareerProfile = { version: 1, tracks: [{ name: 'Financial accounting',
    titleVariants: ['senior accountant', 'старший бухгалтер'], coreSkills: ['financial reporting', 'tax accounting'],
    evidence: ['Senior accountant responsible for financial reporting'] }] };
  const result = prefilterVacancy('Senior accountant. Financial reporting and tax accounting.',
    vacancy('Старший бухгалтер', 'Финансовая отчетность и налоговый учет.'), 20, accountantProfile);
  assert.equal(result.filtered, false);
  assert.match(result.reasons[0], /Financial accounting/);
});

await test('constrained platforms can decline incompatible CV tracks without inventing a search', () => {
  assert.equal(v.safeParse(textSearchProfileSchema, { version: 1, searches: [] }).success, true);
});

await test('age is reported in bands from the advert’s own publication date', () => {
  const at = (days: number) => vacancyRecency({ publishedAt: daysAgo(days) });
  assert.deepEqual([0, 3, 10, 20, 90].map((days) => at(days).band),
    ['today', 'week', 'fortnight', 'month', 'stale']);
  assert.match(at(3).label, /^published /);
  assert.deepEqual([at(3).expired, at(20).expired, at(31).expired], [false, false, true]);
  assert.equal(vacancyRecency({ publishedAt: 'not a date' }).band, 'today',
    'an unreadable date must not be rejected on a guess');
});

await test('an advert past the age limit is rejected however well it matches', () => {
  const strong: [string, string, string[]] = [
    'Senior Communication Designer', 'Create brand identity and visual campaigns.', ['Brand identity'],
  ];
  const fresh = prefilterVacancy(designerCv, vacancy(...strong, daysAgo(0)), 20, designerProfile);
  const expired = prefilterVacancy(designerCv, vacancy(...strong, daysAgo(45)), 20, designerProfile);
  assert.equal(fresh.filtered, false);
  assert.equal(expired.filtered, true, 'over the age limit must be a hard rejection, not a discount');
  assert.ok(expired.reasons.some((reason) => reason.startsWith('rejected: published')));
  assert.equal(expired.regexScore, fresh.regexScore, 'the evidence score is kept for calibration');
});

await test('inside the limit age discounts a match without letting it outrank fit', () => {
  const strong: [string, string, string[]] = [
    'Senior Communication Designer', 'Create brand identity and visual campaigns.', ['Brand identity'],
  ];
  const fresh = prefilterVacancy(designerCv, vacancy(...strong, daysAgo(0)), 20, designerProfile);
  const ageing = prefilterVacancy(designerCv, vacancy(...strong, daysAgo(20)), 20, designerProfile);
  assert.equal(ageing.filtered, false);
  assert.ok(ageing.combinedScore < fresh.combinedScore, 'an ageing advert must score below the same advert today');
  assert.ok(ageing.reasons.some((reason) => reason.startsWith('age discount')));
  assert.equal(fresh.reasons.some((reason) => reason.startsWith('age discount')), false);

  const weakButFresh = prefilterVacancy(designerCv,
    vacancy('Senior Fullstack Developer', 'Build backend services with TypeScript.', ['TypeScript'], daysAgo(0)),
    20, designerProfile);
  assert.ok(ageing.combinedScore > weakButFresh.combinedScore, 'recency must not outrank a genuinely better match');
});

await test('contact details do not create skill evidence', () => {
  const result = prefilterVacancy(designerCv,
    vacancy('Telegram Bot Developer', 'Develop Telegram integrations.', ['Telegram']), 20, designerProfile);
  assert.equal(result.filtered, true);
  assert.equal(result.reasons.some((reason) => reason.startsWith('evidenced skills: Telegram')), false);
});
