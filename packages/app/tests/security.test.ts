import assert from 'node:assert/strict';
import test from 'node:test';
import { redactTrace, safeErrorMessage } from '../src/security.ts';

test('recursive trace redaction removes sensitive keys and bounds depth, arrays, strings, and cycles', () => {
  const value: Record<string, unknown> = { event: 'ok', token: 'secret', nested: { query: 'private search', safe: 'x'.repeat(100) },
    list: [1, 2, 3, 4], url: new URL('https://example.test/path?secret=value#fragment') };
  value.self = value;
  const redacted = redactTrace(value, { depth: 3, array: 2, string: 10 }) as Record<string, unknown>;
  assert.equal(redacted.token, '[REDACTED]'); assert.deepEqual(redacted.list, [1, 2]);
  assert.equal((redacted.nested as Record<string, unknown>).query, '[REDACTED]');
  assert.equal(redacted.url, 'https://example.test/path'); assert.equal(redacted.self, '[CIRCULAR]');
  assert.equal(String((redacted.nested as Record<string, unknown>).safe).length, 10);
});

test('error summaries redact database URLs, Telegram tokens, authorization, emails, secret assignments, and URL queries', () => {
  const error = new Error('postgres://user:pass@db.example/prod failed; Bearer abc.def; bot 123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi; email me@example.com; token=raw https://example.test/path?q=private#x');
  const summary = safeErrorMessage(error);
  for (const secret of ['user:pass', 'abc.def', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'me@example.com', 'token=raw', 'q=private']) {
    assert.equal(summary.includes(secret), false);
  }
  assert.match(summary, /REDACTED/u); assert.match(summary, /https:\/\/example.test\/path/u); assert.ok(summary.length <= 500);
});
