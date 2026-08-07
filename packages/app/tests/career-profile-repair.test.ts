import assert from 'node:assert/strict';
import test from 'node:test';
import * as v from 'valibot';
import { careerProfileSchema, normalizeCareerProfileJson } from '@jobseeker/engine';
import { describeValidationIssues } from '../src/ai.ts';

const packed = {
  version: 1,
  tracks: [{
    name: 'Fullstack',
    titleVariants: ['Fullstack Developer / Фулстек-разработчик', 'Backend Developer | Бэкенд-разработчик'],
    coreSkills: ['TypeScript'],
    evidence: ['Built and shipped web services'],
  }],
};

test('the packed-title response the agent keeps producing fails validation first', () => {
  const result = v.safeParse(careerProfileSchema, packed);
  assert.equal(result.success, false);
  assert.equal(result.issues?.length, 2);
});

test('validation failures name the rejected value so the model can fix it', () => {
  const result = v.safeParse(careerProfileSchema, packed);
  const text = describeValidationIssues(result.issues!);
  assert.match(text, /tracks\.0\.titleVariants\.0:/u);
  assert.match(text, /received "Fullstack Developer \/ Фулстек-разработчик"/u);
  assert.match(text, /one title in one language/u);
});

test('long values are clipped and extra issues are counted, not dropped silently', () => {
  const many = {
    version: 1,
    tracks: [{ name: 'Track', titleVariants: Array.from({ length: 10 }, () => `${'a'.repeat(200)} / b`),
      coreSkills: [], evidence: ['Shipped services'] }],
  };
  const issues = v.safeParse(careerProfileSchema, many).issues!;
  const text = describeValidationIssues(issues);
  assert.equal((text.match(/ — received /gu) ?? []).length, 8); // only the first eight are spelled out
  assert.match(text, new RegExp(`and ${issues.length - 8} further issues`, 'u'));
  assert.match(text, /…/u); // the 200-character value is clipped
  assert.ok(!text.includes('a'.repeat(200)));
});

test('repair splits packed titles into separate validating variants', () => {
  const repaired = v.safeParse(careerProfileSchema, normalizeCareerProfileJson(packed));
  assert.equal(repaired.success, true);
  assert.deepEqual(repaired.output!.tracks[0]!.titleVariants,
    ['Fullstack Developer', 'Фулстек-разработчик', 'Backend Developer', 'Бэкенд-разработчик']);
});

test('repair leaves titles the schema already accepts untouched', () => {
  const clean = { ...packed, tracks: [{ ...packed.tracks[0]!, titleVariants: ['Node.js/React Developer', 'Разработчик'] }] };
  const repaired = normalizeCareerProfileJson(clean) as typeof clean;
  assert.deepEqual(repaired.tracks[0]!.titleVariants, ['Node.js/React Developer', 'Разработчик']);
  assert.equal(v.safeParse(careerProfileSchema, repaired).success, true);
});

test('repair drops duplicates and fragments that cannot be titles', () => {
  const messy = { ...packed, tracks: [{ ...packed.tracks[0]!,
    titleVariants: ['Developer / developer', 'Developer', 'QA / x'] }] };
  const repaired = normalizeCareerProfileJson(messy) as typeof messy;
  assert.deepEqual(repaired.tracks[0]!.titleVariants, ['Developer', 'QA']);
});

test('repair passes through values it does not understand', () => {
  assert.equal(normalizeCareerProfileJson(null), null);
  assert.equal(normalizeCareerProfileJson('text'), 'text');
  assert.deepEqual(normalizeCareerProfileJson({ version: 1 }), { version: 1 });
  assert.deepEqual(normalizeCareerProfileJson({ tracks: [7] }), { tracks: [7] });
});
