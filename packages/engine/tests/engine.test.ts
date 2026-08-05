import assert from 'node:assert/strict';
import test from 'node:test';
import { compileDemand, searchTokens, tokenSimilarity, unitIdentityOf } from '../src/index.ts';

test('canonicalization folds languages and grades into one vocabulary', () => {
  assert.deepEqual([...searchTokens('Senior Machine Learning Engineer')].sort(),
    [...searchTokens('Инженер машинного обучения')].sort());
});

test('unit identity is content-addressed: wording order and grades do not matter, filters do', () => {
  const a = unitIdentityOf('hh', { name: 'ML', text: 'Senior ML Engineer', areas: ['1'] });
  const b = unitIdentityOf('hh', { name: 'МО', text: 'инженер ML', areas: ['1'] });
  const c = unitIdentityOf('hh', { name: 'ML', text: 'Senior ML Engineer', areas: ['2'] });
  assert.equal(a.unitId, b.unitId, 'equivalent demand must collapse into one unit');
  assert.notEqual(a.unitId, c.unitId, 'a different area filter is a different listing page');
});

test('compilation subscribes equivalent searches to one unit and keeps each user\'s own name', () => {
  const demand = compileDemand([
    { userId: 'u1', platform: 'habr', searches: [{ name: 'ML track', query: 'Machine Learning Engineer' }] },
    { userId: 'u2', platform: 'habr', searches: [{ name: 'МО', query: 'Инженер машинного обучения' }] },
  ], 0.6);
  assert.equal(demand.units.length, 1);
  assert.deepEqual(demand.subscriptions.map((s) => [s.userId, s.searchName]).sort(),
    [['u1', 'ML track'], ['u2', 'МО']]);
});

test('adoption is similarity-bounded: unrelated roles never share a unit', () => {
  const demand = compileDemand([
    { userId: 'u1', platform: 'habr', searches: [{ name: 'ML', query: 'ML Engineer' }] },
    { userId: 'u2', platform: 'habr', searches: [{ name: 'Design', query: 'Продуктовый дизайнер' }] },
  ], 0.6);
  assert.equal(demand.units.length, 2);
});

test('compilation is stable under input order', () => {
  const inputs = [
    { userId: 'u1', platform: 'hh', searches: [{ name: 'a', text: 'Python Developer', areas: ['1'] }] },
    { userId: 'u2', platform: 'hh', searches: [{ name: 'b', text: 'Python-разработчик', areas: ['1'] }] },
    { userId: 'u3', platform: 'hh', searches: [{ name: 'c', text: 'Java Developer', areas: ['1'] }] },
  ];
  const forward = compileDemand(inputs, 0.6);
  const reversed = compileDemand([...inputs].reverse(), 0.6);
  assert.deepEqual(forward.units.map((u) => u.unitId).sort(), reversed.units.map((u) => u.unitId).sort());
  assert.equal(forward.subscriptions.length, reversed.subscriptions.length);
});

test('existing units adopt new demand instead of minting duplicates', () => {
  const first = compileDemand([
    { userId: 'u1', platform: 'habr', searches: [{ name: 'ML', query: 'ML Engineer' }] }], 0.6);
  const second = compileDemand([
    { userId: 'u2', platform: 'habr', searches: [{ name: 'МО', query: 'Machine Learning инженер' }] }],
    0.6, first.units);
  assert.equal(second.units.length, 0, 'no new unit should be minted');
  assert.equal(second.subscriptions[0]?.unitId, first.units[0]?.unitId);
});

test('similarity is symmetric and bounded', () => {
  assert.equal(tokenSimilarity(['a', 'b'], ['a', 'b']), 1);
  assert.equal(tokenSimilarity(['a'], ['b']), 0);
  assert.equal(tokenSimilarity([], []), 1);
});
