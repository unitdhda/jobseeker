import assert from 'node:assert/strict';
import test from 'node:test';
import { createRoleTokenResolver, mineRoleEquivalences } from '../src/equivalence.ts';
import { compileDemand } from '../src/subscribe.ts';
import { prefilterVacancy, type CareerProfile } from '../src/prefilter.ts';
import type { VacancyContent } from '../src/contracts.ts';

test('single-token variants of one track pair directly, and grade words never mine', () => {
  const pairs = mineRoleEquivalences([
    { titleVariants: ['Юрист', 'Lawyer'] },
    { titleVariants: ['Старший бухгалтер', 'Senior Accountant'] },
  ]);
  assert.deepEqual(pairs.map((pair) => [pair.tokenA, pair.tokenB]).sort(),
    [['accountant', 'бухгалтер'], ['lawyer', 'юрист']]);
});

test('multi-token variants mine only an unambiguous single residual with an anchor', () => {
  const anchored = mineRoleEquivalences([{ titleVariants: ['Python юрист', 'Python lawyer'] }]);
  assert.deepEqual(anchored.map((pair) => [pair.tokenA, pair.tokenB]), [['lawyer', 'юрист']]);
  // Two residuals per side are ambiguous — nothing may be guessed.
  const ambiguous = mineRoleEquivalences([{ titleVariants: ['Корпоративный юрист', 'Corporate Lawyer'] }]);
  assert.deepEqual(ambiguous, []);
});

test('variants already covered by the core markers leave no residue to learn', () => {
  const pairs = mineRoleEquivalences([
    { titleVariants: ['Инженер машинного обучения', 'Machine Learning Engineer'] },
  ]);
  assert.deepEqual(pairs, []);
});

test('same-script residuals are adjacent roles, never equivalences', () => {
  // Real production tracks span neighbouring titles — merging them would conflate occupations for everyone.
  const pairs = mineRoleEquivalences([
    { titleVariants: ['Frontend Developer', 'Fullstack Developer'] },
    { titleVariants: ['Python разработчик', 'Backend разработчик'] },
  ]);
  assert.deepEqual(pairs, []);
});

test('support accumulates across tracks and users', () => {
  const pairs = mineRoleEquivalences([
    { titleVariants: ['Юрист', 'Lawyer'] },
    { titleVariants: ['Python юрист', 'Python lawyer'] },
  ]);
  assert.deepEqual(pairs, [{ tokenA: 'lawyer', tokenB: 'юрист', support: 2 }]);
});

test('the resolver folds transitive pairs into one class and leaves strangers alone', () => {
  const resolve = createRoleTokenResolver([
    { tokenA: 'accountant', tokenB: 'бухгалтер' },
    { tokenA: 'accountant', tokenB: 'buchhalter' },
  ]);
  assert.equal(resolve('бухгалтер'), resolve('buchhalter'));
  assert.equal(resolve('бухгалтер'), resolve('accountant'));
  assert.equal(resolve('юрист'), 'юрист');
});

const vacancy = (name: string, description: string): VacancyContent => ({
  source: 'hh', sourceId: '1', name, employer: 'Employer', area: '', salaryFrom: null, salaryTo: null,
  salaryCurrency: null, salaryGross: null, experience: '', employment: '', schedule: '', workFormat: '',
  description, keySkills: [], url: '', publishedAt: new Date().toISOString(), sourceQuery: '', contentHash: '' });

test('a learned pair lets an untranslated track admit the cross-language vacancy', () => {
  const profile: CareerProfile = { version: 1, tracks: [{ name: 'Accounting',
    titleVariants: ['Accountant'], coreSkills: ['financial reporting'], evidence: ['Accountant'] }] };
  const resolve = createRoleTokenResolver([{ tokenA: 'accountant', tokenB: 'бухгалтер' }]);
  const cv = 'Accountant. Financial reporting.';
  const withLearned = prefilterVacancy(cv, vacancy('Бухгалтер', 'Учет и отчетность.'), 20, profile, 30, resolve);
  const without = prefilterVacancy(cv, vacancy('Бухгалтер', 'Учет и отчетность.'), 20, profile, 30);
  assert.ok(withLearned.regexScore >= 75, `expected full role evidence, got ${withLearned.regexScore}`);
  assert.equal(without.regexScore, 0, 'without the learned pair the title evidence must stay empty');
});

test('adoption folds equivalent cross-language searches into one unit; identity hashing stays frozen', () => {
  const searches = [
    { userId: 'u1', platform: 'hh', searches: [{ name: 'Бухгалтер', text: 'бухгалтер' }] },
    { userId: 'u2', platform: 'hh', searches: [{ name: 'Accountant', text: 'accountant' }] },
  ];
  const resolve = createRoleTokenResolver([{ tokenA: 'accountant', tokenB: 'бухгалтер' }]);
  const together = compileDemand(searches, 0.6, [], resolve);
  assert.equal(together.units.length, 1, 'one unit serves both users');
  assert.equal(together.subscriptions.length, 2);
  const apart = compileDemand(searches, 0.6, []);
  assert.equal(apart.units.length, 2, 'without the resolver the searches stay separate');
  // The adopted path must not have altered the minted unit's identity.
  assert.equal(together.units[0]!.unitId, apart.units[0]!.unitId);
});
