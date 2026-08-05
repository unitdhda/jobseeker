import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { planPlatformSearches, rotatedClusters, searchTokens, type UserSearches } from '../src/vacancies/plan.ts';
import { discoverPlatformVacancies, getSearchPlatform, searchPlatformIds } from '../src/vacancies/registry.ts';
import { config } from '../src/config.ts';

const hhSearch = (name: string, text: string, areas = ['1']) =>
  ({ name, rationale: 'CV evidence', text, areas });
const textSearch = (name: string, query: string) => ({ name, rationale: 'CV evidence', query });

function demands<T>(entries: [string, T[]][]): UserSearches<T>[] {
  return entries.map(([userId, searches]) => ({ userId, searches }));
}

test('a role reads the same whichever language a user wrote it in', () => {
  assert.deepEqual([...searchTokens('Machine Learning Engineer')].sort(), ['dev', 'ml']);
  assert.deepEqual([...searchTokens('Инженер машинного обучения')].sort(), ['dev', 'ml']);
  assert.deepEqual([...searchTokens('Senior ML Engineer')].sort(), ['dev', 'ml'], 'grade words must not split a cluster');
  assert.notDeepEqual([...searchTokens('Data Scientist')].sort(), [...searchTokens('Data Engineer')].sort());
});

test('equivalent searches from several users become one fetch that serves them all', () => {
  const plan = planPlatformSearches('habr', demands([
    ['u1', [textSearch('ML', 'Machine Learning Engineer')]],
    ['u2', [textSearch('МО', 'Инженер машинного обучения')]],
    ['u3', [textSearch('ML', 'ML-инженер')]],
  ]), {}, 0);
  assert.equal(plan.searches.length, 1, 'three equivalent queries must cost one fetch');
  assert.deepEqual(plan.searches[0]!.recipients.map((recipient) => recipient.userId).sort(), ['u1', 'u2', 'u3']);
  assert.equal(plan.searches[0]!.search.query, 'ML-инженер', 'the broadest member represents the cluster');
});

test('each user keeps their own search name so per-user prefiltering is unchanged', () => {
  const plan = planPlatformSearches('habr', demands([
    ['u1', [textSearch('Backend track', 'Backend Developer')]],
    ['u2', [textSearch('Бэкенд', 'Бэкенд-разработчик')]],
  ]), {}, 0);
  assert.equal(plan.searches.length, 1);
  assert.deepEqual(plan.searches[0]!.recipients,
    [{ userId: 'u1', searchName: 'Backend track' }, { userId: 'u2', searchName: 'Бэкенд' }]);
});

test('unrelated roles are never folded together', () => {
  const plan = planPlatformSearches('habr', demands([
    ['u1', [textSearch('ML', 'Инженер машинного обучения')]],
    ['u2', [textSearch('Design', 'Продуктовый дизайнер')]],
  ]), {}, 0);
  assert.equal(plan.searches.length, 2);
  for (const search of plan.searches) assert.equal(search.recipients.length, 1);
});

test('searches whose filters differ stay apart even when their text agrees', () => {
  const plan = planPlatformSearches('hh', demands([
    ['u1', [hhSearch('Moscow', 'Python-разработчик', ['1'])]],
    ['u2', [hhSearch('Piter', 'Python-разработчик', ['2'])]],
  ]), { mergeText: 'or' }, 0);
  assert.equal(plan.searches.length, 2, 'merging across areas would silently move a user’s search');
});

test('hh folds a cluster into one boolean query instead of several page loads', () => {
  const plan = planPlatformSearches('hh', demands([
    ['u1', [hhSearch('ML', 'инженер машинного обучения')]],
    ['u2', [hhSearch('ML', 'ml-инженер')]],
  ]), { mergeText: 'or' }, 0);
  assert.equal(plan.searches.length, 1);
  assert.equal(plan.searches[0]!.search.text, 'ml-инженер OR инженер машинного обучения');
  assert.ok(plan.searches[0]!.search.text.length <= 300, 'the merged text must satisfy the hh profile schema');
});

test('boards that list everything are planned once for every user at a time', () => {
  const roles = ['Python Developer', 'Java Developer', 'Product Designer', 'Data Scientist',
    'Motion Designer', 'QA Automation', 'Art Director', 'Data Engineer'];
  const many = roles.map((role, index) => textSearch(`t${index}`, role));
  const enumerated = planPlatformSearches('geekjob', demands([['u1', many], ['u2', many]]), { enumerates: true }, 0);
  assert.equal(enumerated.searches.length, 8, 'an enumerated board must keep every query to match titles against');
  const rotated = planPlatformSearches('geekjob', demands([['u1', many], ['u2', many]]), {}, 0);
  assert.ok(rotated.searches.length < enumerated.searches.length, 'query-driven platforms still rotate');
});

const cluster = (id: string, ...userIds: string[]) =>
  ({ search: id, recipients: userIds.map((userId) => ({ userId, searchName: id })) });

test('rotation advances each user through their own clusters without repeats', () => {
  const clusters = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => cluster(id, 'u1'));
  const interval = config.searchRotationMinutes * 60_000;
  const sweep = [0, 1, 2, 3, 4, 5].flatMap((bucket) => rotatedClusters(clusters, 'hh', 1, bucket * interval));
  assert.equal(sweep.length, 6);
  assert.equal(new Set(sweep.map((picked) => picked.search)).size, 6,
    'a full sweep must cover every cluster exactly once');
});

test('every user with a cluster is served every cycle, however lopsided the demand', () => {
  // u1 owns four adjacent clusters; the old contiguous window spent the whole budget inside them.
  const clusters = [cluster('a1', 'u1'), cluster('a2', 'u1'), cluster('a3', 'u1'), cluster('a4', 'u1'),
    cluster('b', 'u2'), cluster('c', 'u3'), cluster('d', 'u4'), cluster('e', 'u5')];
  const interval = config.searchRotationMinutes * 60_000;
  for (const bucket of [0, 1, 2, 3, 4]) {
    const served = new Set(rotatedClusters(clusters, 'hh', 5, bucket * interval)
      .flatMap((picked) => picked.recipients.map((recipient) => recipient.userId)));
    assert.equal(served.size, 5, `bucket ${bucket} must serve all five users`);
  }
});

test('a user with many searches cannot crowd others out of a cycle', () => {
  const plan = planPlatformSearches('habr', demands([
    ['u1', [textSearch('a', 'Python Developer'), textSearch('b', 'Java Developer'),
      textSearch('c', 'Data Scientist'), textSearch('d', 'QA Automation')]],
    ['u2', [textSearch('e', 'Product Designer')]],
    ['u3', [textSearch('f', 'Art Director')]],
  ]), {}, 0);
  const served = new Set(plan.searches.flatMap((search) => search.recipients.map((recipient) => recipient.userId)));
  assert.deepEqual([...served].sort(), ['u1', 'u2', 'u3'], 'one search per user, not three from the largest profile');
});

test('the plan is stable regardless of the order users are prepared in', () => {
  const a: [string, ReturnType<typeof textSearch>[]][] = [['u1', [textSearch('a', 'Python Developer')]],
    ['u2', [textSearch('b', 'Java Developer')]], ['u3', [textSearch('c', 'Python-разработчик')]]];
  const forward = planPlatformSearches('habr', demands(a), {}, 0);
  const reversed = planPlatformSearches('habr', demands([...a].reverse()), {}, 0);
  assert.deepEqual(forward.searches.map((search) => search.search.query),
    reversed.searches.map((search) => search.search.query));
});

test('only the boards that list everything are planned as enumerations', () => {
  const enumerating = searchPlatformIds.filter((id) => getSearchPlatform(id).enumerates);
  assert.deepEqual(enumerating.sort(), ['ats', 'avito', 'geekjob']);
  assert.deepEqual(searchPlatformIds.filter((id) => getSearchPlatform(id).mergeText === 'or'), ['hh'],
    'only hh accepts boolean search text');
});

test('a platform nobody asked for is never fetched', async () => {
  for (const id of searchPlatformIds) {
    const { searches, users, seen, discovered } = await discoverPlatformVacancies(id, []);
    assert.deepEqual({ searches, users, seen, discovered }, { searches: 0, users: 0, seen: 0, discovered: 0 },
      `${id} fetched on an empty plan`);
  }
});

test('a user appearing twice in one cluster is recorded once', () => {
  const plan = planPlatformSearches('habr', demands([
    ['u1', [textSearch('One', 'Backend Developer'), textSearch('Two', 'Бэкенд-разработчик')]],
  ]), {}, 0);
  assert.equal(plan.searches.length, 1);
  assert.equal(plan.searches[0]!.recipients.length, 1);
});

test('HireHi merges the same facet and specialization asked for by several users',()=>{
  const search={name:'Backend',rationale:'CV evidence',specialization:'backend' as const,facet:'all' as const};
  const plan=planPlatformSearches('hirehi',[{userId:'u1',searches:[search]},
    {userId:'u2',searches:[{...search,name:'Бэкенд'}]}],{},0);
  assert.equal(plan.searches.length,1,'one SEO landing page must not be fetched twice');
  assert.deepEqual(plan.searches[0]!.recipients.map(recipient=>recipient.userId),['u1','u2']);
});
