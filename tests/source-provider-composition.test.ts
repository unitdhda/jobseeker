import assert from 'node:assert/strict';
import test from 'node:test';
import { atsSource } from '../src/vacancies/providers/ats.ts';
import { avitoSource } from '../src/vacancies/providers/avito.ts';
import { geekjobSource } from '../src/vacancies/providers/geekjob.ts';
import { habrSource } from '../src/vacancies/providers/habr.ts';
import { hhSource } from '../src/vacancies/providers/hh.ts';
import { hireHiSource } from '../src/vacancies/providers/hirehi.ts';
import { ozonSource } from '../src/vacancies/providers/ozon.ts';
import { rabotaSource } from '../src/vacancies/providers/rabota.ts';
import { rwbSource } from '../src/vacancies/providers/rwb.ts';
import { trudvsemSource } from '../src/vacancies/providers/trudvsem.ts';
import { yandexSource } from '../src/vacancies/providers/yandex.ts';

const factories = [
  hhSource, habrSource, rabotaSource, hireHiSource, geekjobSource, avitoSource,
  trudvsemSource, atsSource, yandexSource, ozonSource, rwbSource,
] as const;
const expectedIds = ['hh', 'habr', 'rabota', 'hirehi', 'geekjob', 'avito', 'trudvsem', 'ats', 'yandex', 'ozon', 'rwb'];

test('application-owned source factories return fresh providers in stable composition order', () => {
  const first = factories.map((factory) => factory());
  const second = factories.map((factory) => factory());
  assert.deepEqual(first.map(({ id }) => id), expectedIds);
  assert.deepEqual(second.map(({ id }) => id), expectedIds);
  for (let index = 0; index < first.length; index++) assert.notEqual(first[index], second[index]);
});

test('HH provider factories retain independent configuration', async () => {
  const first = hhSource({ areaId: '1' });
  const second = hhSource({ areaId: '2' });
  assert.equal(first.template().capabilities.configuredDefaultArea, '1');
  assert.equal(second.template().capabilities.configuredDefaultArea, '2');
  await Promise.all([first.close?.({} as never), second.close?.({} as never)]);
});
