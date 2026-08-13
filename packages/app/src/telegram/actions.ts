import { maximumCvBytes } from '@jobseeker/cv/extract';
import { parseCvContentHash, type CvContentHash, type UserId } from '@jobseeker/engine/contracts';
import type { ApplicationArtifact, DeliveredArtifact } from '@jobseeker/store';
import type { CvParser, CvImportPreview } from '../cv.ts';
import type { JobWorkerClient } from '../worker-client.ts';
import type { WorkflowSessionPorts, UserWorkflowClaim } from './workflow-lock.ts';
import { claimUserWorkflow, resumeUserWorkflow } from './workflow-lock.ts';

const uploadSessionKind = 'cv-upload';
const confirmationSessionKind = 'cv-confirm';
const uploadTtlMs = 15 * 60_000;
const allowedMediaTypes = new Set(['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/markdown', 'text/plain']);

export interface CvActionPorts extends WorkflowSessionPorts {
  getTelegramSession<TResult>(userId: UserId, kind: string): Promise<TResult | null>;
  setTelegramSession(userId: UserId, kind: string, state: unknown, ttlMs: number): Promise<void>;
  deleteTelegramSession(userId: UserId, kind: string): Promise<void>;
  stageCvSource: Parameters<CvParser['parse']>[0] extends never ? never : (userId: UserId, filename: string,
    cvHash: CvContentHash, extraction: Awaited<ReturnType<CvParser['parse']>>['extraction']) => Promise<void>;
  discardStagedCvSource(userId: UserId): Promise<void>;
  confirmStagedCvSource(userId: UserId): Promise<boolean>;
  getCvHash(userId: UserId): Promise<CvContentHash | null>;
}
export interface CvUploadDocument {
  readonly filename: string; readonly mediaType?: string; readonly declaredSize: number;
  download(): Promise<Uint8Array>;
}
export type CvUploadResult =
  | { readonly kind: 'busy'; readonly claim: Extract<UserWorkflowClaim, { claimed: false }> }
  | { readonly kind: 'preview'; readonly preview: CvImportPreview; readonly token: string }
  | { readonly kind: 'invalid'; readonly error: string };

export async function armCvUpload(ports: CvActionPorts, userId: UserId): Promise<boolean> {
  if (await ports.getTelegramSession(userId, uploadSessionKind)) return false;
  await ports.setTelegramSession(userId, uploadSessionKind, { armedAt: new Date().toISOString() }, uploadTtlMs);
  return true;
}
function validUpload(document: CvUploadDocument): string | null {
  if (!document.filename.trim() || document.filename.length > 255) return 'Invalid CV filename.';
  if (!Number.isSafeInteger(document.declaredSize) || document.declaredSize < 1 || document.declaredSize > maximumCvBytes) return 'CV file is too large.';
  if (document.mediaType && !allowedMediaTypes.has(document.mediaType.toLowerCase())) return 'Unsupported CV media type.';
  return null;
}

export async function processCvUpload(input: { readonly ports: CvActionPorts; readonly parser: CvParser;
  readonly userId: UserId; readonly document: CvUploadDocument; readonly errorMessage?: (error: unknown) => string }): Promise<CvUploadResult> {
  if (!await input.ports.getTelegramSession(input.userId, uploadSessionKind)) return { kind: 'invalid', error: 'CV upload is not armed.' };
  const validation = validUpload(input.document); if (validation) return { kind: 'invalid', error: validation };
  const claim = await claimUserWorkflow(input.ports, input.userId, 'cv-import');
  if (!claim.claimed) return Object.freeze({ kind: 'busy', claim });
  try {
    const bytes = await input.document.download();
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > maximumCvBytes) throw new RangeError('Downloaded CV exceeds the byte limit.');
    const parsed = await input.parser.parse(input.document.filename, input.document.mediaType, bytes);
    const hash = parseCvContentHash(parsed.preview.sha256);
    await input.ports.stageCvSource(input.userId, input.document.filename, hash, parsed.extraction);
    await input.ports.deleteTelegramSession(input.userId, uploadSessionKind);
    await input.ports.setTelegramSession(input.userId, confirmationSessionKind,
      { token: claim.lease.state.token, cvHash: hash, preview: parsed.preview }, uploadTtlMs);
    return Object.freeze({ kind: 'preview', preview: parsed.preview, token: claim.lease.state.token });
  } catch (error) {
    await claim.lease.release().catch(() => false);
    return Object.freeze({ kind: 'invalid', error: (input.errorMessage?.(error)
      ?? (error instanceof Error ? error.message : 'CV processing failed.')).slice(0, 500) });
  }
}

interface ConfirmationState { readonly token: string; readonly cvHash: CvContentHash; readonly preview: CvImportPreview }
export async function confirmCvUpload(input: { readonly ports: CvActionPorts; readonly worker: Pick<JobWorkerClient, 'request'>; readonly userId: UserId }): Promise<boolean> {
  const state = await input.ports.getTelegramSession<ConfirmationState>(input.userId, confirmationSessionKind);
  if (!state) return false;
  const lease = await resumeUserWorkflow(input.ports, input.userId, state.token, 'cv-import'); if (!lease) return false;
  try {
    if (!await input.ports.confirmStagedCvSource(input.userId)) return false;
    await input.ports.deleteTelegramSession(input.userId, confirmationSessionKind);
    const hash = await input.ports.getCvHash(input.userId); if (!hash || hash !== state.cvHash) throw new Error('Confirmed CV hash mismatch.');
    if (!await lease.handoff('profile-refresh')) throw new Error('CV workflow lease was lost before profile refresh.');
    await input.worker.request({ type: 'refresh-user', userId: input.userId, cvHash: hash });
    return true;
  } finally { await lease.release().catch(() => false); }
}

export async function rejectCvUpload(ports: CvActionPorts, userId: UserId): Promise<boolean> {
  const state = await ports.getTelegramSession<ConfirmationState>(userId, confirmationSessionKind); if (!state) return false;
  const lease = await resumeUserWorkflow(ports, userId, state.token, 'cv-import');
  await ports.discardStagedCvSource(userId); await ports.deleteTelegramSession(userId, confirmationSessionKind);
  await ports.setTelegramSession(userId, uploadSessionKind, { armedAt: new Date().toISOString() }, uploadTtlMs);
  await lease?.release().catch(() => false); return true;
}

export interface ApplicationActionPorts extends WorkflowSessionPorts {
  saveDeliveredArtifact(userId: UserId, vacancyId: number, artifact: ApplicationArtifact,
    value: Omit<DeliveredArtifact, 'deliveredAt'>, deliveredAt: Date): Promise<boolean>;
  markApplicationDelivered(userId: UserId, vacancyId: number, artifact: ApplicationArtifact): Promise<boolean>;
}
export interface ApplicationTransport {
  sendDocument(userId: UserId, bytes: Uint8Array, filename: string): Promise<{ readonly fileId: string }>;
  sendFileId(userId: UserId, fileId: string): Promise<void>;
  sendText(userId: UserId, text: string): Promise<void>;
}
export async function deliverApplicationArtifact(input: { readonly ports: ApplicationActionPorts; readonly worker: Pick<JobWorkerClient, 'request'>;
  readonly transport: ApplicationTransport; readonly userId: UserId; readonly vacancyId: number; readonly artifact: ApplicationArtifact }): Promise<'busy' | 'cached' | 'generated'> {
  const workflowKind = input.artifact === 'cv' ? 'tailored-cv' : 'cover-letter';
  const claim = await claimUserWorkflow(input.ports, input.userId, workflowKind);
  if (!claim.claimed) return 'busy';
  try {
    const result = await input.worker.request({ type: 'tailor-application', userId: input.userId,
      vacancyId: input.vacancyId, artifact: input.artifact });
    if (result.type !== 'tailor-application' || result.artifact !== input.artifact) throw new TypeError('Worker returned the wrong application artifact.');
    if (result.artifact === 'cv') {
      if (result.kind === 'cached') { if (!result.fileId) throw new TypeError('Cached CV has no file ID.');
        await input.transport.sendFileId(input.userId, result.fileId); return 'cached'; }
      if (!result.pdf) throw new TypeError('Generated CV has no PDF bytes.');
      const sent = await input.transport.sendDocument(input.userId, result.pdf, `tailored-${input.vacancyId}.pdf`);
      if (!await input.ports.saveDeliveredArtifact(input.userId, input.vacancyId, 'cv', { cvSha256: result.cvHash, fileId: sent.fileId }, new Date())) {
        throw new Error('Delivered CV metadata could not be saved.');
      }
    } else {
      await input.transport.sendText(input.userId, result.text);
      if (result.kind === 'cached') return 'cached';
      if (!await input.ports.saveDeliveredArtifact(input.userId, input.vacancyId, 'letter', { cvSha256: result.cvHash, text: result.text }, new Date())) {
        throw new Error('Delivered letter metadata could not be saved.');
      }
    }
    if (!await input.ports.markApplicationDelivered(input.userId, input.vacancyId, input.artifact)) {
      throw new Error('Application delivery state could not be saved.');
    }
    return 'generated';
  } finally { await claim.lease.release().catch(() => false); }
}
