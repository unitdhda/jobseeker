import { parseCvContentHash, parseUserId, type CvContentHash, type UserId } from '@jobseeker/engine/contracts';
import type { ApplicationArtifact } from '@jobseeker/store';

export type JobPayload =
  | { readonly type: 'refresh-user'; readonly userId: UserId; readonly cvHash: CvContentHash }
  | { readonly type: 'tailor-application'; readonly userId: UserId; readonly vacancyId: number; readonly artifact: ApplicationArtifact };
export type SerializedJobResult =
  | { readonly type: 'refresh-user'; readonly cvHash: CvContentHash; readonly generatedPlatforms: readonly string[]; readonly failedPlatforms: Readonly<Record<string, string>> }
  | { readonly type: 'tailor-application'; readonly artifact: 'cv'; readonly kind: 'cached' | 'generated'; readonly cvHash: CvContentHash; readonly fileId?: string; readonly pdfBase64?: string }
  | { readonly type: 'tailor-application'; readonly artifact: 'letter'; readonly kind: 'cached' | 'generated'; readonly cvHash: CvContentHash; readonly text: string };
export type JobResult =
  | Extract<SerializedJobResult, { type: 'refresh-user' }>
  | { readonly type: 'tailor-application'; readonly artifact: 'cv'; readonly kind: 'cached' | 'generated'; readonly cvHash: CvContentHash; readonly fileId?: string; readonly pdf?: Uint8Array }
  | Extract<SerializedJobResult, { type: 'tailor-application'; artifact: 'letter' }>;

export type JobWorkerRequest = { readonly kind: 'request'; readonly id: number; readonly payload: JobPayload };
export type JobWorkerMessage =
  | { readonly kind: 'ready' }
  | { readonly kind: 'result'; readonly id: number; readonly ok: true; readonly result: SerializedJobResult }
  | { readonly kind: 'result'; readonly id: number; readonly ok: false; readonly error: string };

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Invalid job IPC object.');
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const expected = [...keys].sort().join(',');
  if (Object.keys(value).sort().join(',') !== expected) throw new TypeError('Invalid job IPC fields.');
}
function positiveId(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new RangeError(`Invalid ${name}.`);
  return value as number;
}

export function parseJobPayload(value: unknown): JobPayload {
  const input = record(value);
  if (input.type === 'refresh-user') {
    exactKeys(input, ['type', 'userId', 'cvHash']);
    return Object.freeze({ type: 'refresh-user', userId: parseUserId(input.userId), cvHash: parseCvContentHash(input.cvHash) });
  }
  if (input.type === 'tailor-application') {
    exactKeys(input, ['type', 'userId', 'vacancyId', 'artifact']);
    if (input.artifact !== 'cv' && input.artifact !== 'letter') throw new TypeError('Invalid application artifact job.');
    return Object.freeze({ type: 'tailor-application', userId: parseUserId(input.userId),
      vacancyId: positiveId(input.vacancyId, 'application vacancy ID'), artifact: input.artifact });
  }
  throw new TypeError('Invalid job payload type.');
}

export function parseJobWorkerRequest(value: unknown): JobWorkerRequest {
  const input = record(value); exactKeys(input, ['kind', 'id', 'payload']);
  if (input.kind !== 'request') throw new TypeError('Invalid job IPC request kind.');
  return Object.freeze({ kind: 'request', id: positiveId(input.id, 'job request ID'), payload: parseJobPayload(input.payload) });
}

export function deserializeJobResult(value: SerializedJobResult): JobResult {
  if (value.type === 'refresh-user') return value;
  if (value.artifact === 'letter') return value;
  const { pdfBase64, ...rest } = value;
  if (value.kind === 'generated') {
    if (!pdfBase64 || value.fileId !== undefined || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(pdfBase64)) {
      throw new TypeError('Invalid generated CV worker result.');
    }
    const pdf = Uint8Array.from(Buffer.from(pdfBase64, 'base64'));
    if (pdf.byteLength === 0) throw new TypeError('Invalid empty CV worker result.');
    return Object.freeze({ ...rest, pdf });
  }
  if (!value.fileId || pdfBase64 !== undefined) throw new TypeError('Invalid cached CV worker result.');
  return Object.freeze(rest);
}
