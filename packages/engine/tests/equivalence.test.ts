import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSourceKey } from '../src/contracts.ts';
import {
  createRoleTokenResolver,
  mineRoleEquivalences,
} from '../src/equivalence.ts';
import { tokenSimilarity, unitIdentityOf } from '../src/identity.ts';

test('mining accepts precise cross-script residuals and rejects same-script adjacent roles', () => {
  const pairs = mineRoleEquivalences([
    { titleVariants: ['Backend developer', 'Backend разработчик'] },
    { titleVariants: ['Accountant', 'Бухгалтер'] },
    { titleVariants: ['Product manager', 'Project manager'] },
  ]);
  assert.deepEqual(pairs, [
    { tokenA: 'accountant', tokenB: 'бухгалтер', support: 1 },
    { tokenA: 'developer', tokenB: 'разработчик', support: 1 },
  ]);
});

test('resolver builds deterministic transitive classes', () => {
  const pairs = [
    { tokenA: 'developer', tokenB: 'разработчик', support: 2 },
    { tokenA: 'developer', tokenB: 'programmer', support: 1 },
  ] as const;
  const resolver = createRoleTokenResolver(pairs);
  const reversed = createRoleTokenResolver([...pairs].reverse());
  assert.equal(resolver('programmer'), 'developer');
  assert.equal(resolver('разработчик'), 'developer');
  assert.equal(reversed('разработчик'), resolver('разработчик'));
});

test('learned equivalence changes comparison without identity drift', () => {
  const platform = parseSourceKey('example');
  const english = unitIdentityOf(platform, { text: 'developer' });
  const russian = unitIdentityOf(platform, { text: 'разработчик' });
  const resolver = createRoleTokenResolver([
    { tokenA: 'developer', tokenB: 'разработчик', support: 1 },
  ]);
  assert.notEqual(english.unitId, russian.unitId);
  assert.equal(tokenSimilarity(english.canonicalTokens, russian.canonicalTokens, resolver), 1);
  assert.equal(unitIdentityOf(platform, { text: 'developer' }).unitId, english.unitId);
});
