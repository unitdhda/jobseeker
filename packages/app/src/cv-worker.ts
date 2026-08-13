import { createInterface } from 'node:readline';
import { extractCvDocument } from '@jobseeker/cv/extract';

interface CvWorkerRequest {
  readonly filename: string;
  readonly mediaType?: string;
  readonly bytesBase64: string;
}

interface SerializedError {
  readonly name: string;
  readonly code?: string;
  readonly message: string;
}

function errorResult(error: unknown): { readonly ok: false; readonly error: SerializedError } {
  const value = error instanceof Error ? error : new Error('Unknown CV parser failure.');
  const code = 'code' in value && typeof value.code === 'string' ? value.code : undefined;
  return {
    ok: false,
    error: { name: value.name, ...(code ? { code } : {}), message: value.message.slice(0, 1_000) },
  };
}

async function handle(line: string): Promise<unknown> {
  const request = JSON.parse(line) as Partial<CvWorkerRequest>;
  if (typeof request.filename !== 'string' || typeof request.bytesBase64 !== 'string'
    || (request.mediaType !== undefined && typeof request.mediaType !== 'string')) {
    throw new TypeError('Invalid CV worker request.');
  }
  // Copy out of Node's Buffer-backed view so the domain boundary receives an ordinary Uint8Array.
  const bytes = Uint8Array.from(Buffer.from(request.bytesBase64, 'base64'));
  return {
    ok: true,
    extraction: await extractCvDocument(request.filename, request.mediaType, bytes),
  };
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let received = false;
lines.on('line', async (line) => {
  if (received) {
    process.stdout.write(`${JSON.stringify(errorResult(new Error('CV worker accepts exactly one request.')))}\n`);
    process.exitCode = 1;
    lines.close();
    return;
  }
  received = true;
  try {
    process.stdout.write(`${JSON.stringify(await handle(line))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(errorResult(error))}\n`);
    process.exitCode = 1;
  } finally {
    lines.close();
  }
});
lines.on('close', () => {
  if (!received) {
    process.stdout.write(`${JSON.stringify(errorResult(new Error('CV worker received no request.')))}\n`);
    process.exitCode = 1;
  }
});
