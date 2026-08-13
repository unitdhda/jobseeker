import assert from 'node:assert/strict';
import test from 'node:test';
import * as v from 'valibot';
import { parseCvContentHash } from '@jobseeker/engine/contracts';
import {
  careerProfileLimits,
  careerProfileSchema,
  missingSearchProfiles,
  normalizeCareerProfileJson,
  parseStoredSearchProfile,
  storedCareerProfile,
  storedSearchProfile,
} from '../src/career-profile.ts';

const hash = parseCvContentHash('a'.repeat(64));
const career = v.parse(careerProfileSchema, { version: 1, tracks: [{ name: 'Backend engineer',
  titleVariants: ['Backend Engineer', 'Бэкенд-разработчик'], coreSkills: ['TypeScript'], evidence: ['Built typed APIs'] }] });
const sourceSchema = v.strictObject({ version: v.literal(1), searches: v.pipe(v.array(v.strictObject({ name: v.string(), query: v.string() })), v.maxLength(2)) });
const provider = { id: 'test', schema: sourceSchema, template: () => ({ platform: 'test', version: 2, purpose: 'test',
  jsonShape: {}, capabilities: { maxSearches: 2 }, rules: ['At most 2 searches.'] }) };

test('career profile repair splits packed translated titles, deduplicates, and respects every engine cap', () => {
  const repaired = normalizeCareerProfileJson({ version: 1, tracks: [{ name: 'Backend engineer',
    titleVariants: ['Backend Engineer / Бэкенд-разработчик', 'backend engineer'],
    coreSkills: Array.from({ length: careerProfileLimits.coreSkills + 5 }, (_, index) => `Skill ${index}`),
    evidence: ['Built API', 'built api'] }] });
  const parsed = v.parse(careerProfileSchema, repaired);
  assert.deepEqual(parsed.tracks[0]!.titleVariants, ['Backend Engineer', 'Бэкенд-разработчик']);
  assert.equal(parsed.tracks[0]!.coreSkills.length, careerProfileLimits.coreSkills);
  assert.deepEqual(parsed.tracks[0]!.evidence, ['Built API']);
});

test('stored career and provider profiles bind both CV hash and provider template version', () => {
  const storedCareer = storedCareerProfile(hash, career); assert.equal(storedCareer.cvHash, hash);
  const stored = storedSearchProfile(hash, 2, sourceSchema, { version: 1, searches: [] });
  assert.deepEqual(parseStoredSearchProfile(stored, hash, 2, sourceSchema).profile, { version: 1, searches: [] });
  assert.throws(() => parseStoredSearchProfile(stored, parseCvContentHash('b'.repeat(64)), 2, sourceSchema), /stale/u);
  assert.throws(() => parseStoredSearchProfile(stored, hash, 3, sourceSchema), /stale/u);
});

test('missing profile report detects absent, malformed, stale-CV, and stale-template entries', () => {
  const validCareer = storedCareerProfile(hash, career);
  const validSearch = storedSearchProfile(hash, 2, sourceSchema, { version: 1, searches: [] });
  assert.deepEqual(missingSearchProfiles({ career: validCareer, searches: { test: validSearch } }, hash, [provider]),
    { career: false, platforms: [] });
  const stale = missingSearchProfiles({ career: { ...validCareer, cvHash: 'b'.repeat(64) },
    searches: { test: { ...validSearch, templateVersion: 1 } } }, hash, [provider]);
  assert.equal(stale.career, true); assert.deepEqual(stale.platforms, ['test']);
});
