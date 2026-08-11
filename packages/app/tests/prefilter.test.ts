import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildIdfVocabulary, careerProfileSchema, combinedEvidenceScore, createIdfLookup, prefilterVacancy,
  uniformIdfLookup, vacancyRecency,
  type CareerProfile,
} from '@jobseeker/engine';
import type { Vacancy } from '@jobseeker/store';
import * as v from 'valibot';
import { textSearchProfileSchema } from '@jobseeker/sources/examples/habr';
import { config } from '../src/config.ts';
import { matchEvidence, matchOrderingScore } from '../src/matching.ts';

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

await test('role markers let untranslated tracks meet cross-language adverts', () => {
  const profile: CareerProfile = { version: 1, tracks: [{ name: 'Python engineering',
    titleVariants: ['Python Developer'], coreSkills: ['machine learning', 'Python'],
    evidence: ['Python developer building machine learning services'] }] };
  const cv = 'Python developer. Machine learning services in production.';
  const russian = prefilterVacancy(cv,
    vacancy('Разработчик Python', 'Развиваем сервисы машинного обучения на Python.', ['Python']),
    20, profile);
  assert.equal(russian.reasons.some((reason) => reason.includes('title-variant similarity: 1.000')), true,
    'разработчик and developer must meet on the shared role marker');
  assert.ok(russian.regexScore >= 75, `expected full role evidence, got ${russian.regexScore}`);
  assert.equal(russian.reasons.some((reason) => reason.includes('machine learning')), true,
    'the machine-learning skill must be evidenced through машинного обучения');
  assert.equal(russian.filtered, false);

  const unrelated = prefilterVacancy(cv,
    vacancy('Коммуникационный дизайнер', 'Фирменный стиль и визуальные кампании.'), 20, profile);
  assert.equal(unrelated.filtered, true, 'markers must not admit a different occupation');
});

await test('an expired advert reports expiry separately from the evidence verdict', () => {
  const fresh = prefilterVacancy(designerCv,
    vacancy('Senior Communication Designer', 'Brand identity and visual campaigns.'), 20, designerProfile);
  assert.equal(fresh.expired, false);
  const stale = prefilterVacancy(designerCv,
    vacancy('Senior Communication Designer', 'Brand identity and visual campaigns.', [], daysAgo(45)),
    20, designerProfile);
  assert.deepEqual([stale.expired, stale.filtered], [true, true]);
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
  assert.equal(expired.regexScore, fresh.regexScore, 'the evidence score is retained for diagnostics');
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

test('the prefilter reports title similarity and skill coverage separately from the combined score', () => {
  const strong = prefilterVacancy(designerCv,
    vacancy('Communication Designer', 'Create brand identity and visual campaigns for launches.',
      ['Brand identity', 'Visual campaigns']), 20, designerProfile);
  const weak = prefilterVacancy(designerCv,
    vacancy('Senior Fullstack Developer', 'Build backend services with TypeScript.', ['TypeScript']),
    20, designerProfile);

  // Both are shares, so they stay inside the unit interval whatever the profile looks like.
  for (const result of [strong, weak]) {
    assert.ok(result.titleSimilarity >= 0 && result.titleSimilarity <= 1, 'title similarity is a 0..1 share');
    assert.ok(result.skillCoverage >= 0 && result.skillCoverage <= 1, 'skill coverage is a 0..1 share');
  }
  // A matching title and both core skills present must outrank an unrelated role on each signal independently,
  // which is the whole point of freezing them apart from regexScore.
  assert.ok(strong.titleSimilarity > weak.titleSimilarity);
  assert.ok(strong.skillCoverage > weak.skillCoverage);
  assert.equal(strong.skillCoverage, 1); // both of the track's two core skills appear
  assert.equal(weak.skillCoverage, 0);
});

test('the seniority gap is recorded signed, and absent when neither title names a grade', () => {
  const leadProfile: CareerProfile = { version: 1, tracks: [
    { name: 'Backend', titleVariants: ['lead backend developer'], coreSkills: ['Go'],
      evidence: ['Led a backend team'] }] };
  const cv = 'Lead backend developer with Go experience.';
  const gapFor = (title: string) =>
    prefilterVacancy(cv, vacancy(title, 'Backend work with Go', ['Go']), 20, leadProfile).seniorityGap;

  // The advert asks below the CV's grade, and above it, and the sign has to distinguish the two.
  assert.ok(gapFor('junior backend developer')! < 0, 'a junior advert sits below a lead CV');
  assert.equal(gapFor('lead backend developer'), 0, 'the same grade is a gap of zero');
  assert.ok(gapFor('head of backend')! > 0, 'a head advert sits above a lead CV');
  // Null, not zero: an advert that names no grade is unknown, which is not the same as matching.
  assert.equal(gapFor('backend developer'), null);

  const gradelessProfile: CareerProfile = { version: 1, tracks: [
    { name: 'Backend', titleVariants: ['backend developer'], coreSkills: ['Go'], evidence: ['Backend work'] }] };
  assert.equal(prefilterVacancy(cv, vacancy('senior backend developer', 'Go', ['Go']), 20, gradelessProfile)
    .seniorityGap, null, 'a CV naming no grade cannot be compared either');
});

test('recording the seniority gap does not move the score it is not yet weighed by', () => {
  // It ships as frozen evidence only. If this starts failing, admission has quietly changed on an unvalidated
  // guess, which is the thing the split evidence was careful not to do either.
  const profile: CareerProfile = { version: 1, tracks: [
    { name: 'Backend', titleVariants: ['lead backend developer'], coreSkills: ['Go'], evidence: ['Backend'] }] };
  const cv = 'Lead backend developer with Go experience.';
  const junior = prefilterVacancy(cv, vacancy('junior backend developer', 'Go work', ['Go']), 20, profile);
  const graded = prefilterVacancy(cv, vacancy('lead backend developer', 'Go work', ['Go']), 20, profile);
  assert.notEqual(junior.seniorityGap, graded.seniorityGap);
  // Both titles carry the same role tokens once grade is stripped, so the evidence score must be identical.
  assert.equal(junior.regexScore, graded.regexScore);
});

test('the stored evidence score remains the raw combined score', () => {
  const lens = { userId: 'u1', cvText: designerCv, profile: designerProfile };
  const advert = vacancy('Communication Designer', 'Create brand identity and visual campaigns.', ['Brand identity']);
  const evidence = matchEvidence(lens, advert, new Date());
  assert.ok(evidence);
  assert.equal(evidence.score, prefilterVacancy(designerCv, advert, config.prefilterMinScore,
    designerProfile, config.prefilterMaxAgeDays).combinedScore);
});

test('raw fallback ordering recomputes recency at claim time', () => {
  const candidate = { vacancyId: 1, matchedAt: daysAgo(40), source: 'hh', publishedAt: daysAgo(40),
    regexScore: 60, lexicalCosine: 0.1, titleSimilarity: 0.8, skillCoverage: 0.5, seniorityGap: null,
    specificity: null, lexicalCosineIdf: null };
  const fresh = { ...candidate, publishedAt: daysAgo(0) };
  assert.ok(matchOrderingScore(candidate, new Date()) < matchOrderingScore(fresh, new Date()));
  assert.equal(matchOrderingScore(fresh, new Date()), combinedEvidenceScore(60, 0.1, 1));
});

test('specificity separates a match on a common word from a match on a rare one', () => {
  // The defect it exists for: a token-set ratio scores both of these 1.0, and on production that pile was 49%
  // of every match ever made and converted worse than the band beneath it.
  const profile: CareerProfile = { version: 1, tracks: [
    { name: 'Design', titleVariants: ['designer', 'communication designer'], coreSkills: [],
      evidence: ['Designer'] }] };
  const corpus = [
    ...Array.from({ length: 200 }, () => ['designer']),
    ...Array.from({ length: 2 }, () => ['communication', 'designer']),
  ];
  const idf = { title: createIdfLookup(buildIdfVocabulary(corpus)), body: uniformIdfLookup };

  const common = prefilterVacancy('Designer', vacancy('Designer', 'Design work'), 20, profile, 30,
    undefined, idf);
  const rare = prefilterVacancy('Communication designer',
    vacancy('Communication designer', 'Design work'), 20, profile, 30, undefined, idf);

  assert.equal(common.titleSimilarity, 1, 'the ratio saturates for both — that is the problem being fixed');
  assert.equal(rare.titleSimilarity, 1);
  assert.ok(rare.specificity! > common.specificity!,
    `rare words must score higher: rare=${rare.specificity} common=${common.specificity}`);
});

test('rarity evidence is null, not zero, until a vocabulary exists', () => {
  // Null and zero are different claims, and conflating them was measured to invert the fitted coefficient.
  const profile: CareerProfile = { version: 1, tracks: [
    { name: 'Design', titleVariants: ['designer'], coreSkills: [], evidence: ['Designer'] }] };
  const unmeasured = prefilterVacancy('Designer', vacancy('Designer', 'Design work'), 20, profile);
  assert.equal(unmeasured.specificity, null);
  assert.equal(unmeasured.lexicalCosineIdf, null);
  // Each answers for its own vocabulary: a title vocabulary alone leaves only the body feature unmeasured.
  const titleOnly = prefilterVacancy('Designer', vacancy('Designer', 'Design work'), 20, profile, 30, undefined,
    { title: createIdfLookup(buildIdfVocabulary([['designer'], ['designer', 'lead']])), body: uniformIdfLookup });
  assert.notEqual(titleOnly.specificity, null);
  assert.equal(titleOnly.lexicalCosineIdf, null);

  const idf = { title: createIdfLookup(buildIdfVocabulary([['designer'], ['designer', 'lead']])),
    body: createIdfLookup(buildIdfVocabulary([['design', 'work'], ['design', 'systems']])) };
  const measured = prefilterVacancy('Designer', vacancy('Designer', 'Design work'), 20, profile, 30,
    undefined, idf);
  assert.notEqual(measured.specificity, null);
  assert.notEqual(measured.lexicalCosineIdf, null);
});

test('rarity evidence does not move the score it is not yet weighed by', () => {
  // New diagnostic evidence must not silently change admission.
  const profile: CareerProfile = { version: 1, tracks: [
    { name: 'Design', titleVariants: ['designer'], coreSkills: ['design'], evidence: ['Designer'] }] };
  const idf = { title: createIdfLookup(buildIdfVocabulary([['designer'], ['designer', 'lead']])),
    body: createIdfLookup(buildIdfVocabulary([['design', 'work'], ['design', 'systems']])) };
  const without = prefilterVacancy('Designer', vacancy('Designer', 'Design work'), 20, profile);
  const with_ = prefilterVacancy('Designer', vacancy('Designer', 'Design work'), 20, profile, 30,
    undefined, idf);
  assert.equal(without.combinedScore, with_.combinedScore);
  assert.equal(without.filtered, with_.filtered);
});
