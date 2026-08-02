import assert from 'node:assert/strict';
import test from 'node:test';
import { careerProfileSchema, type CareerProfile } from '../src/lib/career-profile.ts';
import { prefilterVacancy } from '../src/lib/prefilter.ts';
import type { Vacancy } from '../src/lib/database.ts';
import * as v from 'valibot';
import { avitoPlatform, getmatchPlatform, textSearchProfileSchema } from '../src/platforms/additional.ts';
import { hireHiPlatform } from '../src/platforms/hirehi.ts';

function vacancy(name: string, description: string, keySkills: string[] = []): Vacancy {
  return { id: 1, source: 'hh', sourceId: '1', applyId: 'aaaaaa', name, employer: 'Employer', area: 'Remote',
    salaryFrom: null, salaryTo: null, salaryCurrency: null, salaryGross: null, experience: '', employment: '', schedule: '',
    workFormat: '', description, keySkills, url: 'https://hh.ru/vacancy/1', publishedAt: '2026-01-01', sourceQuery: name,
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
    20, 0.93, designerProfile);
  assert.equal(unrelated.filtered, true);
  assert.ok(unrelated.combinedScore < 20);
  assert.equal(unrelated.reasons.some((reason) => reason.includes('software-role title')), false);

  const relevant = prefilterVacancy(designerCv,
    vacancy('Senior Communication Designer', 'Create brand identity and visual campaigns.', ['Brand identity']),
    20, 0.96, designerProfile);
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
    vacancy('Продуктовый дизайнер', 'Продуктовый дизайн.'), 20, null, profile);
  assert.equal(result.filtered, false);
  assert.equal(result.reasons.includes('title-variant similarity: 1.000'),true);
  assert.ok(result.regexScore >= 75);
});

await test('the same generic model supports non-design occupations', () => {
  const accountantProfile: CareerProfile = { version: 1, tracks: [{ name: 'Financial accounting',
    titleVariants: ['senior accountant', 'старший бухгалтер'], coreSkills: ['financial reporting', 'tax accounting'],
    evidence: ['Senior accountant responsible for financial reporting'] }] };
  const result = prefilterVacancy('Senior accountant. Financial reporting and tax accounting.',
    vacancy('Старший бухгалтер', 'Финансовая отчетность и налоговый учет.'), 20, 0.96, accountantProfile);
  assert.equal(result.filtered, false);
  assert.match(result.reasons[0], /Financial accounting/);
});

await test('constrained platforms can decline incompatible CV tracks without inventing a search', () => {
  assert.equal(v.safeParse(avitoPlatform.schema, { version: 1, searches: [] }).success, true);
  assert.equal(v.safeParse(hireHiPlatform.schema, { version: 1, searches: [] }).success, true);
  assert.equal(v.safeParse(getmatchPlatform.schema, { version: 1, searches: [] }).success, true);
  assert.equal(v.safeParse(textSearchProfileSchema, { version: 1, searches: [] }).success, true);
  assert.doesNotMatch(JSON.stringify(avitoPlatform.template()), /frontend developer/i);
});

await test('contact details do not create skill evidence', () => {
  const result = prefilterVacancy(designerCv,
    vacancy('Telegram Bot Developer', 'Develop Telegram integrations.', ['Telegram']), 20, null, designerProfile);
  assert.equal(result.filtered, true);
  assert.equal(result.reasons.some((reason) => reason.startsWith('evidenced skills: Telegram')), false);
});
