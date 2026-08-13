import { createSourceHttp, type SourceHttp, type SourceUrlPolicy } from './http.ts';
import type { VacancyCandidateInput } from '@jobseeker/engine/contracts';

export interface SourceLimits {
  readonly searchNewVacancyLimit: number;
  readonly searchPageBudgetPerPlatform: number;
}

export interface SourcesOptions {
  readonly limits: SourceLimits;
  trace(event: string, data?: unknown): void;
  errorMessage(error: unknown): string;
  recordListingCandidate(input: VacancyCandidateInput): Promise<boolean>;
}

export interface SourceContext extends SourcesOptions {
  readonly http: SourceHttp;
}

function positiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`Invalid source ${name}: expected a positive safe integer.`);
  }
}

export function snapshotSourcesOptions(options: SourcesOptions): SourcesOptions {
  if (!options || typeof options !== 'object') throw new TypeError('Invalid sources options.');
  positiveSafeInteger(options.limits.searchNewVacancyLimit, 'new-vacancy limit');
  positiveSafeInteger(options.limits.searchPageBudgetPerPlatform, 'page budget');
  if (typeof options.trace !== 'function' || typeof options.errorMessage !== 'function'
    || typeof options.recordListingCandidate !== 'function') {
    throw new TypeError('Invalid sources options: expected trace, errorMessage, and listing callbacks.');
  }
  return Object.freeze({
    limits: Object.freeze({ ...options.limits }),
    trace: options.trace,
    errorMessage: options.errorMessage,
    recordListingCandidate: options.recordListingCandidate,
  });
}

export function createSourceContext(options: SourcesOptions, urlPolicy: SourceUrlPolicy): SourceContext {
  const snapshot = snapshotSourcesOptions(options);
  return Object.freeze({ ...snapshot, http: createSourceHttp(urlPolicy) });
}
