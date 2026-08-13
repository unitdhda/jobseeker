import assert from 'node:assert/strict';
import test from 'node:test';
import * as v from 'valibot';
import * as sources from '../src/index.ts';
import * as api from '../src/drivers/api.ts';
import * as ats from '../src/drivers/ats.ts';
import * as companySite from '../src/drivers/company-site.ts';
import * as jsonLdBoard from '../src/drivers/jsonld-board.ts';
import registerAts, { atsSource } from '../examples/ats.ts';
import registerAvito, { avitoSource } from '../examples/avito.ts';
import registerGeekjob, { geekjobSource } from '../examples/geekjob.ts';
import registerHabr, { habrSource } from '../examples/habr.ts';
import registerKontur, { konturSource } from '../examples/kontur.ts';
import registerRabota, { rabotaSource } from '../examples/rabota.ts';
import { boardListings } from '../examples/text.ts';
import { initToolkit, type SourceExtensionApi } from '../examples/toolkit.ts';

function extensionApi(registered: sources.AnySourceProvider[] = []): SourceExtensionApi {
  return {
    registerSourceProvider: (provider) => { registered.push(provider); },
    env: {},
    sources: Object.assign({}, sources, { drivers: { api, ats, companySite, jsonLdBoard } }),
  };
}

initToolkit(extensionApi());

test('board and ATS example factories return fresh providers with unique closed host declarations', () => {
  const factories = [habrSource, rabotaSource, geekjobSource, avitoSource, konturSource];
  const providers = [...factories.map((factory) => factory()), atsSource()];
  assert.deepEqual(providers.map((provider) => provider.id), ['habr', 'rabota', 'geekjob', 'avito', 'kontur', 'ats']);
  assert.equal(new Set(providers.map((provider) => provider.id)).size, providers.length);
  for (const [index, factory] of factories.entries()) {
    assert.notEqual(factory(), providers[index]);
    assert.ok(providers[index]!.hosts.length > 0);
    assert.equal(new Set(providers[index]!.hosts).size, providers[index]!.hosts.length);
  }
  assert.deepEqual(atsSource().hosts, ats.atsHosts);
});

test('example profile schemas are strict and template caps match the schema limit', () => {
  for (const provider of [habrSource(), rabotaSource(), geekjobSource(), avitoSource(), konturSource(), atsSource()]) {
    const valid = { version: 1, searches: Array.from({ length: 8 }, (_, index) => ({
      name: `Role ${index}`, rationale: 'Direct CV evidence', query: `Developer ${index}`,
    })) };
    assert.equal(v.safeParse(provider.schema, valid).success, true, provider.id);
    assert.equal(v.safeParse(provider.schema, { ...valid, searches: [...valid.searches, valid.searches[0]], extra: true }).success,
      false, provider.id);
    assert.equal(provider.template().capabilities.maxSearches, 8, provider.id);
    assert.match(provider.template().rules.join(' '), /at most 8/iu, provider.id);
  }
});

test('shared board listing codec preserves real JSON-LD and card titles and dates', () => {
  const jsonLd = JSON.stringify({ '@type': 'JobPosting', title: 'Backend Engineer',
    url: 'https://career.habr.com/vacancies/123', datePosted: '2026-02-03' });
  const html = `<script type="application/ld+json">${jsonLd}</script>
    <a href="/vacancies/456"><strong>Frontend Engineer</strong></a><time>2 февраля 2026</time>`;
  const listings = boardListings(html, 'https://career.habr.com',
    /<a\b[^>]*href=["'](?<url>\/vacancies\/\d+)["'][^>]*>(?<title>[\s\S]*?)<\/a>(?:[\s\S]{0,100}?<time[^>]*>(?<date>[\s\S]*?)<\/time>)?/giu);
  assert.deepEqual(listings, [
    { sourceId: '123', url: 'https://career.habr.com/vacancies/123', title: 'Backend Engineer', publishedAt: '2026-02-03' },
    { sourceId: '456', url: 'https://career.habr.com/vacancies/456', title: 'Frontend Engineer',
      publishedAt: '2026-02-02T00:00:00.000Z' },
  ]);
});

test('individual example modules default-register exactly their own fresh provider', () => {
  const registered: sources.AnySourceProvider[] = [];
  const fixture = extensionApi(registered);
  for (const register of [registerHabr, registerRabota, registerGeekjob, registerAvito, registerKontur, registerAts]) {
    register(fixture);
  }
  assert.deepEqual(registered.map((provider) => provider.id), ['habr', 'rabota', 'geekjob', 'avito', 'kontur', 'ats']);
});
