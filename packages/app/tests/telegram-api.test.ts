import assert from 'node:assert/strict';
import test from 'node:test';
import { downloadTelegramFile } from '../src/telegram/api.ts';

const response = (chunks: readonly Uint8Array[], headers: Record<string, string> = {}, status = 200): Response => new Response(
  new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }),
  { status, headers });

test('Telegram file downloader validates path/status and never includes token in failures', async () => {
  await assert.rejects(downloadTelegramFile({ token: 'TOP_SECRET', filePath: '../secret', fetch: async () => response([]) }), /invalid file path/u);
  await assert.rejects(downloadTelegramFile({ token: 'TOP_SECRET', filePath: 'docs/cv.pdf', fetch: async () => response([], {}, 503) }),
    (error: unknown) => error instanceof Error && /503/u.test(error.message) && !error.message.includes('TOP_SECRET'));
});

test('Telegram file downloader rejects declared and streamed overflow and concatenates bounded bytes', async () => {
  let readerRequested = false;
  const declaredOverflow = { ok: true, status: 200, headers: new Headers({ 'content-length': '4' }),
    body: { getReader() { readerRequested = true; throw new Error('body must not be read'); } } } as unknown as Response;
  await assert.rejects(downloadTelegramFile({ token: 'x', filePath: 'docs/cv.pdf', maximumBytes: 3,
    fetch: async () => declaredOverflow }), /byte limit/u);
  assert.equal(readerRequested, false);
  await assert.rejects(downloadTelegramFile({ token: 'x', filePath: 'docs/cv.pdf', maximumBytes: 3,
    fetch: async () => response([new Uint8Array([1, 2]), new Uint8Array([3, 4])]) }), /byte limit/u);
  assert.deepEqual(await downloadTelegramFile({ token: 'x', filePath: 'docs/cv.pdf', maximumBytes: 4,
    fetch: async () => response([new Uint8Array([1, 2]), new Uint8Array([3, 4])]) }), new Uint8Array([1, 2, 3, 4]));
});
