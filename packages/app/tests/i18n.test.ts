import assert from 'node:assert/strict';
import test from 'node:test';
import { en, messages, resolveLocale, ru, supportedLocale } from '../src/i18n/index.ts';

test('English has exactly the Russian-derived catalogue keys and contains no Cyrillic text', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ru).sort());
  const rendered = [
    ...Object.values(en).filter((value): value is string => typeof value === 'string'),
    en.accessCooldown(10), en.busy('operation'), en.digestTitle(1, 2),
  ].join('\n');
  assert.doesNotMatch(rendered, /\p{Script=Cyrillic}/u);
  assert.equal(messages('ru'), ru); assert.equal(messages('en'), en);
});

test('locale resolution prefers explicit stored choice, then supported client language, then deployment default', () => {
  assert.equal(resolveLocale({ stored: 'ru', explicitlySelected: true, clientLanguage: 'en-US', defaultLocale: 'en' }), 'ru');
  assert.equal(resolveLocale({ stored: 'ru', explicitlySelected: false, clientLanguage: 'en-US', defaultLocale: 'ru' }), 'en');
  assert.equal(resolveLocale({ stored: null, explicitlySelected: false, clientLanguage: 'ru-RU', defaultLocale: 'en' }), 'ru');
  assert.equal(resolveLocale({ stored: null, explicitlySelected: false, clientLanguage: 'de', defaultLocale: 'en' }), 'en');
  assert.equal(resolveLocale({ stored: 'ru', explicitlySelected: false, clientLanguage: 'de', defaultLocale: 'en' }), 'ru');
});

test('supported locale parsing accepts primary subtags only and rejects ambiguous values', () => {
  assert.equal(supportedLocale('EN_us'), 'en'); assert.equal(supportedLocale('ru-RU'), 'ru');
  assert.equal(supportedLocale('russian'), null); assert.equal(supportedLocale(''), null); assert.equal(supportedLocale(undefined), null);
});
