import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as v from 'valibot';
import * as sources from '../../../packages/sources/src/index.ts';
import * as apiDriver from '../../../packages/sources/src/drivers/api.ts';
import * as atsDriver from '../../../packages/sources/src/drivers/ats.ts';
import * as companyDriver from '../../../packages/sources/src/drivers/company-site.ts';
import * as boardDriver from '../../../packages/sources/src/drivers/jsonld-board.ts';
import { AdaptiveTaskPool, mapConcurrent } from '../../../packages/engine/src/concurrency.ts';
import {
  createHhBrowser,
  hhPlatform,
  hhPublishedAt,
  hhSearchProfileSchema,
  hhSearchUrl,
  hhSource,
  maxHhSearches,
  type HhBrowserOptions,
} from '../hh.ts';
import { initToolkit } from '../toolkit.ts';

initToolkit({
  registerSourceProvider() {}, registerAiProvider() {}, onStartup() {}, onShutdown() {}, env: {}, log() {},
  sources: Object.assign({}, sources, { drivers: { api: apiDriver, ats: atsDriver, companySite: companyDriver, jsonLdBoard: boardDriver } }),
  concurrency: { AdaptiveTaskPool, mapConcurrent },
  state: { configured: () => false, get: async () => null, put: async () => {}, delete: async () => {} },
});

const validSearch = { name: 'Backend', rationale: 'Direct CV evidence', text: 'бэкенд разработчик', areas: ['1'],
  periodDays: 30, workFormats: ['REMOTE'] as ('REMOTE')[], salary: { amount: 100000, currency: 'RUR' as const } };

test('HH schema enforces Russian text, required areas, bounded filters, and cap parity', () => {
  const valid = { version: 1, searches: Array.from({ length: maxHhSearches }, () => validSearch) };
  assert.equal(v.safeParse(hhSearchProfileSchema, valid).success, true);
  assert.equal(v.safeParse(hhSearchProfileSchema, { ...valid, searches: [...valid.searches, validSearch] }).success, false);
  assert.equal(v.safeParse(hhSearchProfileSchema, { version: 1, searches: [{ ...validSearch, text: 'backend developer' }] }).success, false);
  assert.equal(v.safeParse(hhSearchProfileSchema, { version: 1, searches: [{ ...validSearch, areas: [] }] }).success, false);
  assert.equal(hhPlatform('1').template().capabilities.maxSearches, maxHhSearches);
});

test('HH URL carries bounded period and explicit filters without losing repeated values', () => {
  const url = new URL(hhSearchUrl({ ...validSearch, areas: ['1', '2'], searchFields: ['name', 'description'],
    excludedText: 'стажер', orderBy: 'salary_desc' }, 2));
  assert.equal(url.origin, 'https://hh.ru'); assert.equal(url.searchParams.get('page'), '2');
  assert.equal(url.searchParams.get('period'), '30'); assert.deepEqual(url.searchParams.getAll('area'), ['1', '2']);
  assert.deepEqual(url.searchParams.getAll('search_field'), ['name', 'description']);
  assert.equal(url.searchParams.get('salary'), '100000'); assert.equal(url.searchParams.get('currency'), 'RUR');
});

test('HH publication date prefers JobPosting then visible Russian text', () => {
  const html = `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', datePosted: '2026-01-02' })}</script>`;
  assert.equal(hhPublishedAt(html, 'Вакансия опубликована 1 января 2025'), '2026-01-02T00:00:00.000Z');
  assert.equal(hhPublishedAt('', 'Вакансия опубликована 31 декабря', new Date('2026-01-02')), '2025-12-31T00:00:00.000Z');
  assert.equal(hhPublishedAt('', 'No date'), null);
});

function browserOptions(path: string): HhBrowserOptions {
  return { browserDataPath: path, operationTimeoutSeconds: 0.02, playwrightHeadless: true, timezone: 'UTC',
    browserEnvironment: { lang: 'C.UTF-8', path: '/usr/bin:/bin', tmpdir: '/tmp' } };
}

test('browser runtime launches lazily, retries, blocks heavy resources, resets after timeout, and closes idempotently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hh-browser-test-'));
  try {
    let launches = 0; let closes = 0; let routeHandler: ((route: any) => unknown) | undefined;
    const contexts: any[] = [];
    const runtime = createHhBrowser(browserOptions(join(root, 'hh-browser')), {
      launchPersistentContext: async (_path, options) => {
        launches += 1;
        assert.equal(options?.chromiumSandbox, true); assert.equal(options?.serviceWorkers, 'block'); assert.equal(options?.locale, 'ru-RU');
        if (launches === 1) throw new Error('launch failed');
        const context = { route: async (_glob: string, handler: (route: any) => unknown) => { routeHandler = handler; },
          close: async () => { closes += 1; }, pages: () => [] };
        contexts.push(context); return context as unknown as import('playwright').BrowserContext;
      },
      sleep: async () => {},
    });
    assert.equal(launches, 0);
    assert.equal(await runtime.run('ok', async () => 1), 1); assert.equal(launches, 2);
    let action = ''; await routeHandler?.({ request: () => ({ resourceType: () => 'image' }), abort: () => { action = 'abort'; }, continue: () => { action = 'continue'; } });
    assert.equal(action, 'abort');
    await assert.rejects(() => runtime.run('timeout', async () => new Promise(() => {})), /timed out/u);
    assert.equal(closes, 1);
    assert.equal(await runtime.run('after-reset', async () => 2), 2); assert.equal(launches, 3);
    await runtime.close(); await runtime.close(); assert.equal(closes, 2);
    void contexts;
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('HH source factories are independent and browser-free until runtime methods execute', () => {
  let closed = 0;
  const fake = { run: async <T>(_name: string, operation: (context: any) => Promise<T>) => operation({ pages: () => [] }),
    close: async () => { closed += 1; } };
  const one = hhSource({ browser: fake, areaId: '1' }); const two = hhSource({ browser: fake, areaId: '2' });
  assert.notEqual(one, two); assert.equal(one.id, 'hh'); assert.equal(two.template().capabilities.configuredDefaultArea, '2');
  assert.equal(closed, 0);
});
