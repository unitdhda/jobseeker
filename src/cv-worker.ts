import { extractCvDocument } from './lib/cv-adapters.ts';
import type { ExtractedCvDocument } from './lib/cv-adapters.ts';

interface CvWorkerRequest {
  filename: string;
  mediaType?: string;
  bytes: Buffer | Uint8Array | { type: 'Buffer'; data: number[] };
}
type CvWorkerResponse = { ok: true; result: ExtractedCvDocument } | { ok: false; error: string };

let handled = false;
process.on('message', (request: CvWorkerRequest) => {
  if (handled) return;
  handled = true;
  const input = request.bytes;
  const bytes = input instanceof Uint8Array ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    : input?.type === 'Buffer' && Array.isArray(input.data) ? Uint8Array.from(input.data) : new Uint8Array();
  void extractCvDocument(request.filename, request.mediaType, bytes)
    .then((result) => process.send?.({ ok: true, result } satisfies CvWorkerResponse))
    .catch((error) => process.send?.({ ok: false,
      error: error instanceof Error ? error.message : String(error) } satisfies CvWorkerResponse))
    .finally(() => process.disconnect?.());
});
