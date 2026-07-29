import type { GeneratedApplication } from './application-artifacts.ts';
import type { ScrapeCycleResult } from './jobs.ts';

export type JobWorkerRequest =
  | { id: number; type: 'run-cycle' }
  | { id: number; type: 'refresh-user'; userId: string; cvHash: string }
  | { id: number; type: 'tailor-application'; userId: string; vacancyId: number };

export interface RefreshUserResult {
  searchCount: number;
  platformCount: number;
  cycle: ScrapeCycleResult | null;
}
export interface SerializedApplication extends Omit<GeneratedApplication, 'tailoredCvPdf'> {
  tailoredCvPdfBase64: string;
}

export type JobWorkerSuccess = { kind: 'result'; id: number; ok: true; result: unknown };
export type JobWorkerFailure = { kind: 'result'; id: number; ok: false; error: string };
export type JobWorkerMessage = { kind: 'ready' } | JobWorkerSuccess | JobWorkerFailure;
