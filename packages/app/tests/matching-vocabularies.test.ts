import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIdfVocabulary } from '@jobseeker/engine/idf';
import { createMatchingVocabularies, type MatchingVocabularyPorts } from '../src/matching-vocabularies.ts';

function fixture(overrides: Partial<MatchingVocabularyPorts> = {}) {
  const saved: unknown[] = []; let calls = 0;
  const ports: MatchingVocabularyPorts = {
    loadRoleEquivalences: async () => [{ tokenA: 'developer', tokenB: 'разработчик', support: 2 }],
    loadIdfVocabulary: async (scope) => buildIdfVocabulary(scope === 'title' ? [['backend', 'engineer'], ['backend']] : [['typescript'], ['typescript', 'api']]),
    roleTrackTitles: async () => [{ titleVariants: ['Backend developer', 'Backend разработчик'] }],
    vacancyTextBatch: async (after, limit) => { calls += 1;
      const rows = [{ id: 1, title: 'Backend Engineer', body: 'TypeScript APIs' }, { id: 2, title: 'Backend Developer', body: 'TypeScript services' }];
      return rows.filter((row) => row.id > after).slice(0, limit); },
    replaceRoleEquivalences: async (value) => { saved.push({ equivalences: value }); },
    replaceMatchingVocabularies: async (value) => { saved.push(value); }, ...overrides,
  };
  return { ports, saved, calls: () => calls };
}

test('startup loads persisted vocabulary without scanning or rebuilding corpus', async () => {
  const value = fixture(); const vocabularies = createMatchingVocabularies(value.ports, { corpusBatchSize: 1 });
  assert.equal(vocabularies.snapshot().loaded, false); assert.equal(vocabularies.snapshot().idfLookups.title.documents, 0);
  const loaded = await vocabularies.load();
  assert.equal(loaded.loaded, true); assert.equal(loaded.rebuiltAt, null); assert.equal(value.calls(), 0); assert.equal(value.saved.length, 0);
  assert.equal(loaded.roleResolver('разработчик'), loaded.roleResolver('developer'));
  assert.equal(loaded.idfLookups.title.documents, 2);
});

test('daily rebuild pages corpus, persists one atomic generation, then publishes it', async () => {
  const value = fixture(); const vocabularies = createMatchingVocabularies(value.ports, { corpusBatchSize: 1 });
  const rebuilt = await vocabularies.rebuild();
  assert.equal(value.calls(), 3); assert.equal(value.saved.length, 1); assert.ok(rebuilt.rebuiltAt instanceof Date);
  assert.equal(rebuilt.idfLookups.title.documents, 2); assert.equal(rebuilt.idfLookups.body.documents, 2);
  assert.equal(rebuilt.roleResolver('разработчик'), rebuilt.roleResolver('developer'));
  assert.equal(vocabularies.snapshot(), rebuilt);
});

test('lightweight equivalence refresh persists and publishes roles without rebuilding the IDF corpus', async () => {
  const value = fixture(); const vocabularies = createMatchingVocabularies(value.ports);
  const loaded = await vocabularies.load(); const refreshed = await vocabularies.refreshEquivalences();
  assert.equal(value.calls(), 0); assert.equal(value.saved.length, 1);
  assert.equal(refreshed.idfLookups, loaded.idfLookups);
  assert.equal(refreshed.roleResolver('разработчик'), refreshed.roleResolver('developer'));
});

test('failed rebuild retains the previously published snapshot', async () => {
  let fail = false;
  const first = fixture({ replaceMatchingVocabularies: async () => { if (fail) throw new Error('persistence failed'); } });
  const vocabularies = createMatchingVocabularies(first.ports);
  const loaded = await vocabularies.load(); fail = true;
  await assert.rejects(vocabularies.rebuild(), /persistence failed/u);
  assert.equal(vocabularies.snapshot(), loaded);
});

test('corpus must be strictly ordered and concurrent rebuilds serialize', async () => {
  let active = 0; let maximum = 0;
  const value = fixture({ vacancyTextBatch: async () => [{ id: 0, title: 'bad', body: 'bad' }],
    replaceMatchingVocabularies: async () => { active += 1; maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5)); active -= 1; } });
  const invalid = createMatchingVocabularies(value.ports);
  await assert.rejects(invalid.rebuild(), /strictly ordered/u);
  const serialFixture = fixture({ replaceMatchingVocabularies: value.ports.replaceMatchingVocabularies });
  const serial = createMatchingVocabularies(serialFixture.ports);
  await Promise.all([serial.rebuild(), serial.rebuild()]); assert.equal(maximum, 1);
});
