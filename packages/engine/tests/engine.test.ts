import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseSourceKey,
  parseSourceVacancyId,
  parseUserId,
  type VacancyContent,
} from '../src/contracts.ts';
import { roleNgramSimilarity, searchTokens } from '../src/canon.ts';
import { unitIdentityOf } from '../src/identity.ts';
import { buildIdfVocabulary, createIdfLookup } from '../src/idf.ts';
import {
  careerProfileSchema,
  normalizeCareerProfileJson,
  prefilterVacancy,
} from '../src/prefilter.ts';
import { compileDemand } from '../src/subscribe.ts';
import * as v from 'valibot';

test('canonicalization preserves identity tokens and compares morphology without translation guesses', () => {
  assert.deepEqual([...searchTokens('Senior C++ / .NET Developer')], ['c++', '.net', 'developer']);
  assert.ok(roleNgramSimilarity(searchTokens('разработчик'), searchTokens('разработчика')) > 0.7);
  assert.equal(roleNgramSimilarity(searchTokens('developer'), searchTokens('разработчик')), 0);
});

test('unit identity is stable across private labels and recursive key order', () => {
  const platform = parseSourceKey('example');
  const first = unitIdentityOf(platform, {
    name: 'Private label', rationale: 'Private rationale', text: 'Backend Developer',
    filters: { remote: true, levels: [1, 2] }, salary: 100,
  });
  const second = unitIdentityOf(platform, {
    salary: 100, filters: { levels: [1, 2], remote: true }, query: 'Backend Developer',
    name: 'Other label', rationale: 'Other rationale',
  });
  assert.equal(first.unitId, second.unitId);
  assert.deepEqual(first.canonicalTokens, ['backend', 'developer']);
});

test('profile repair splits and deduplicates packed title variants before strict parsing', () => {
  const repaired = normalizeCareerProfileJson({ version: 1, tracks: [{
    name: 'Engineering',
    titleVariants: [' Developer / Разработчик ', 'developer'],
    coreSkills: [' TypeScript ', 'typescript'],
    evidence: [' Built APIs '],
  }] });
  const profile = v.parse(careerProfileSchema, repaired);
  assert.deepEqual(profile.tracks[0]!.titleVariants, ['Developer', 'Разработчик']);
  assert.deepEqual(profile.tracks[0]!.coreSkills, ['TypeScript']);
});

test('prefilter requires role or skill evidence and keeps IDF diagnostic-only', () => {
  const profile = v.parse(careerProfileSchema, { version: 1, tracks: [{
    name: 'Backend engineering', titleVariants: ['Backend Developer'],
    coreSkills: ['TypeScript'], evidence: ['Built APIs'],
  }] });
  const vacancy: VacancyContent = {
    source: parseSourceKey('example'), sourceId: parseSourceVacancyId('42'), name: 'Backend Developer',
    employer: 'Acme', area: 'Remote', salary: null, experience: { kind: 'unspecified' },
    employment: 'full-time', schedule: 'flexible', workFormat: 'remote', description: 'TypeScript APIs',
    keySkills: ['TypeScript'], url: new URL('https://example.test/42'), publishedAt: new Date('2026-01-01'),
    sourceQuery: 'private',
  };
  const options = { profile, minimumScore: 1, maxAgeDays: 30, now: new Date('2026-01-02') } as const;
  const plain = prefilterVacancy('Backend TypeScript APIs', vacancy, options);
  const title = createIdfLookup(buildIdfVocabulary([['backend'], ['backend'], ['accountant']]));
  const body = createIdfLookup(buildIdfVocabulary([['typescript'], ['typescript'], ['accounting']]));
  const measured = prefilterVacancy('Backend TypeScript APIs', vacancy, { ...options, idfLookups: { title, body } });
  assert.equal(measured.filtered, false);
  assert.equal(measured.combinedScore, plain.combinedScore);
  assert.notEqual(measured.specificity, null);
  const unrelated = prefilterVacancy('Excellent communication', {
    ...vacancy, name: 'Accountant', description: 'Excellent communication', keySkills: [],
  }, options);
  assert.equal(unrelated.filtered, true);
  assert.ok(unrelated.reasons.includes('insufficient-role-or-skill-evidence'));
});

test('demand compilation is input-order stable and adopts learned cross-language equivalence', () => {
  const platform = parseSourceKey('example');
  const one = parseUserId('1');
  const two = parseUserId('2');
  interface ExampleSearch {
    readonly name: string;
    readonly text: string;
    readonly area: number;
  }
  const demands: readonly {
    readonly userId: typeof one;
    readonly platform: typeof platform;
    readonly searches: readonly ExampleSearch[];
  }[] = [
    { userId: two, platform, searches: [{ name: 'Russian', text: 'разработчик', area: 1 }] },
    { userId: one, platform, searches: [{ name: 'English', text: 'developer', area: 1 }] },
  ];
  const resolver = (token: string): string =>
    token === 'developer' || token === 'разработчик' ? 'role:developer' : token;
  const forward = compileDemand(demands, 0.9, [], resolver);
  const backward = compileDemand([...demands].reverse(), 0.9, [], resolver);
  assert.deepEqual(forward, backward);
  assert.equal(forward.units.length, 1);
  assert.equal(forward.subscriptions.length, 2);
});
