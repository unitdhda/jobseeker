import assert from 'node:assert/strict';
import test from 'node:test';
import { searchProfileMessage } from '../src/telegram.ts';

const view = {
  filename: 'cv.pdf',
  tracks: ['Fullstack-разработка', 'Backend'],
  platforms: [
    { label: 'HH', terms: ['fullstack разработчик', 'backend разработчик'] },
    { label: 'HireHi', terms: [] },
  ],
};

test('search profile lists tracks, queries and platforms without searches', () => {
  const text = searchProfileMessage(view);
  assert.match(text, /Резюме: cv\.pdf/u);
  assert.match(text, /Направления: Fullstack-разработка · Backend/u);
  assert.match(text, /Запросы: 2 на 1 площадках/u);
  assert.match(text, /• HH: «fullstack разработчик», «backend разработчик»/u);
  assert.match(text, /Без запросов: HireHi\./u);
});

test('long lists are summarised instead of printed in full', () => {
  const terms = Array.from({ length: 8 }, (_unused, index) => `запрос ${index}`);
  const text = searchProfileMessage({ ...view, tracks: Array.from({ length: 9 }, (_u, index) => `трек ${index}`),
    platforms: [{ label: 'HH', terms }] });
  assert.match(text, /трек 5 и ещё 3/u);
  assert.match(text, /«запрос 3» и ещё 4/u);
  assert.ok(!text.includes('запрос 4'));
});

test('an empty profile reports that no searches exist yet', () => {
  const text = searchProfileMessage({ filename: 'cv.pdf', tracks: [], platforms: [{ label: 'HH', terms: [] }] });
  assert.match(text, /Поисковые запросы пока не созданы\./u);
  assert.ok(!text.includes('Запросы:'));
});

test('user-controlled values are HTML-escaped', () => {
  const text = searchProfileMessage({ filename: '<b>cv</b>.pdf', tracks: ['a & b'],
    platforms: [{ label: 'HH', terms: ['<script>'] }] });
  assert.match(text, /&lt;b&gt;cv&lt;\/b&gt;\.pdf/u);
  assert.match(text, /a &amp; b/u);
  assert.match(text, /«&lt;script&gt;»/u);
});
