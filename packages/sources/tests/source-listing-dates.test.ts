import './toolkit-fixture.ts';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { russianDate } from '@jobseeker/sources';
import { habrListings } from '../examples/habr.ts';

// Taken verbatim from a live career.habr.com result card.
const habrCard = `<section class="basic-section basic-section--appearance-vacancy-card"><div class="vacancy-card vacancy-card--bp">`
  + `<a aria-label="Python AI Engineer" class="vacancy-card__backdrop-link" href="/vacancies/1000167946"></a>`
  + `<div class="vacancy-card__inner"><div class="vacancy-card__date">`
  + `<time class="basic-date" datetime="2026-08-03T17:46:58+03:00">3 августа</time></div>`
  + `<a class="vacancy-card__icon-link" href="/vacancies/1000167946"><img src="x.png" /></a>`
  + `<div class="vacancy-card__info"><div class="vacancy-card__title">`
  + `<a class="vacancy-card__title-link" href="/vacancies/1000167946">Python AI Engineer</a></div></div></div></div></section>`;

test('a Russian listing date is read, and an undated one falls back to the most recent occurrence', () => {
  const now = new Date('2026-08-04T12:00:00Z');
  assert.equal(russianDate('29 июля 2026', now), '2026-07-29T00:00:00.000Z');
  assert.equal(russianDate('3 августа', now), '2026-08-03T00:00:00.000Z');
  // December with no year cannot mean next December, so it belongs to the year before.
  assert.equal(russianDate('20 декабря', now), '2025-12-20T00:00:00.000Z');
  assert.equal(russianDate('3 сентебря 2026', now), null, 'an unknown month must not be guessed');
  assert.equal(russianDate('no date here', now), null);
});

test('habr listings carry the advert’s date and its real title, not the backdrop link', () => {
  const [listing, ...rest] = habrListings(habrCard, 'https://career.habr.com/vacancies?q=python');
  assert.equal(rest.length, 0, 'the three links in one card are one listing');
  assert.equal(listing!.sourceId, '1000167946');
  assert.equal(listing!.url, 'https://career.habr.com/vacancies/1000167946');
  assert.equal(listing!.title, 'Python AI Engineer', 'the backdrop anchor is empty and must not become the title');
  assert.equal(listing!.publishedAt, '2026-08-03T14:46:58.000Z');
});

test('habr falls back to scanning links when the card markup changes', () => {
  const listings = habrListings(
    '<a href="/vacancies/42?from=list">Data Engineer</a><a href="/vacancies/42">Data Engineer</a>',
    'https://career.habr.com/vacancies');
  assert.deepEqual(listings, [{ sourceId: '42', url: 'https://career.habr.com/vacancies/42', title: 'Data Engineer' }]);
});
