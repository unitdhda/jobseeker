import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSourceHttp,
  createSourceUrlPolicy,
  hashedVacancy,
  htmlText,
  isPublicIpAddress,
  jobPostings,
  parseSalaryText,
  readResponseBytes,
  russianDate,
  structuredLocation,
  structuredVacancy,
  type SourceHttpDependencies,
} from '../src/index.ts';
import {
  parseSourceKey,
  parseSourceVacancyId,
} from '@jobseeker/engine/contracts';

const policy = createSourceUrlPolicy([{ id: 'demo', hosts: ['jobs.example.test'] }]);

function dependencies(responses: readonly Response[], addresses = ['93.184.216.34']): SourceHttpDependencies {
  let index = 0;
  return {
    lookup: async () => addresses.map((address) => ({ address })),
    fetch: async () => responses[index++] ?? (() => { throw new Error('Unexpected fetch'); })(),
  };
}

test('URL policy requires exact HTTPS host without credentials or any explicit port', () => {
  assert.equal(policy.safeVacancyUrl('demo', 'https://jobs.example.test/a'), 'https://jobs.example.test/a');
  for (const input of [
    'http://jobs.example.test/a', 'https://user@jobs.example.test/a', 'https://jobs.example.test:443/a',
    'https://sub.jobs.example.test/a', 'https://jobs.example.test.evil.test/a', 'https://127.0.0.1/a',
  ]) assert.throws(() => policy.sourceUrl('demo', input), /Unsafe demo URL/u);
});

test('IP classification allows only public unicast and rejects mapped private IPv4', () => {
  assert.equal(isPublicIpAddress('93.184.216.34'), true);
  assert.equal(isPublicIpAddress('2606:4700:4700::1111'), true);
  for (const address of ['127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.1.1', '0.0.0.0',
    '224.0.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:10.0.0.1']) {
    assert.equal(isPublicIpAddress(address), false, address);
  }
});

test('HTTP revalidates DNS and same-origin redirects while preserving custom headers', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  let resolutions = 0;
  const deps: SourceHttpDependencies = {
    lookup: async () => { resolutions += 1; return [{ address: '93.184.216.34' }]; },
    fetch: async (url, init) => {
      calls.push({ url, init });
      return calls.length === 1
        ? new Response(null, { status: 302, headers: { location: '/next' } })
        : new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
  };
  const http = createSourceHttp(policy, deps);
  assert.deepEqual(await http.fetchSourceJson('demo', 'https://jobs.example.test/start', {
    headers: { authorization: 'Bearer test', 'x-custom': 'yes' },
  }), { ok: true });
  assert.equal(resolutions, 2);
  assert.deepEqual(calls.map((call) => call.url), ['https://jobs.example.test/start', 'https://jobs.example.test/next']);
  const headers = new Headers(calls[0]!.init.headers);
  assert.equal(headers.get('authorization'), 'Bearer test');
  assert.equal(headers.get('x-custom'), 'yes');
  assert.equal(headers.get('user-agent'), 'JobseekerVacancyMonitor/1.0');

  const crossOrigin = createSourceHttp(policy, dependencies([
    new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/path' } }),
  ]));
  await assert.rejects(() => crossOrigin.fetchSourceResponse('demo', 'https://jobs.example.test/start'),
    /Unsafe demo URL/u);
});

test('DNS rejects the whole request when any resolved address is unsafe', async () => {
  const http = createSourceHttp(policy, dependencies([], ['93.184.216.34', '10.0.0.1']));
  await assert.rejects(() => http.fetchSourceResponse('demo', 'https://jobs.example.test/a'),
    /exclusively to public unicast/u);
});

test('response reader enforces declared and streamed byte limits', async () => {
  await assert.rejects(() => readResponseBytes(new Response('12345', {
    headers: { 'content-length': '5' },
  }), 4), /byte limit/u);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('123')); controller.enqueue(new TextEncoder().encode('45')); controller.close(); },
  });
  await assert.rejects(() => readResponseBytes(new Response(stream), 4), /byte limit/u);
});

test('JSON and HTML helpers enforce media types without exposing response bodies', async () => {
  const json = createSourceHttp(policy, dependencies([
    new Response('{bad', { headers: { 'content-type': 'application/json' } }),
  ]));
  await assert.rejects(() => json.fetchSourceJson('demo', 'https://jobs.example.test/a'),
    (error) => error instanceof SyntaxError && !error.message.includes('{bad'));
  const html = createSourceHttp(policy, dependencies([
    new Response('{}', { headers: { 'content-type': 'application/json' } }),
  ]));
  await assert.rejects(() => html.fetchSourceHtml('demo', 'https://jobs.example.test/a'), /non-HTML/u);
});

test('text, Russian date, and JSON-LD parsing handle realistic markup independently', () => {
  assert.equal(htmlText('<style>secret</style><h1>A &amp; B</h1><p>Line&nbsp;two</p>'), 'A & B Line two');
  assert.equal(russianDate('Опубликовано 31 декабря', new Date('2026-01-02T00:00:00Z')),
    '2025-12-31T00:00:00.000Z');
  assert.equal(russianDate('1 января 2024'), '2024-01-01T00:00:00.000Z');
  assert.equal(russianDate('31 февраля 2024'), null);
  const postings = jobPostings(`<script type="application/ld+json">{"@graph":[{"@type":"Organization"},{"@type":"JobPosting","title":"Real"}]}</script>
    <script type="application/ld+json">bad</script>`);
  assert.equal(postings.length, 1);
  assert.equal(postings[0]?.title, 'Real');
});

test('structured salary/location and vacancy hashing preserve engine contracts', () => {
  assert.deepEqual(parseSalaryText('от 100 000 до 150 000 RUB gross'), {
    from: 100000, to: 150000, currency: 'RUB', gross: true, period: 'month',
  });
  const posting = {
    '@type': 'JobPosting', title: 'Backend Developer',
    description: '<p>Build deterministic TypeScript services with a careful engineering team.</p>',
    datePosted: '2026-01-02T00:00:00Z', hiringOrganization: { name: 'Example' },
    jobLocation: [{ address: { addressLocality: 'Berlin', addressCountry: 'DE' } }],
    baseSalary: { currency: 'EUR', value: { minValue: 5000, maxValue: 7000, unitText: 'MONTH' } },
    employmentType: 'FULL_TIME', skills: 'TypeScript; PostgreSQL', jobLocationType: 'TELECOMMUTE',
  };
  assert.equal(structuredLocation(posting), 'Berlin, DE');
  const vacancy = structuredVacancy('demo', '1', 'https://jobs.example.test/1', 'private query', posting);
  assert.ok(vacancy);
  assert.equal(vacancy.workFormat, 'remote');
  assert.equal(vacancy.salary?.currency, 'EUR');
  const changedQuery = hashedVacancy({ ...vacancy, sourceQuery: 'another private query' });
  assert.equal(changedQuery.contentHash, vacancy.contentHash);
  assert.equal(vacancy.source, parseSourceKey('demo'));
  assert.equal(vacancy.sourceId, parseSourceVacancyId('1'));
});
