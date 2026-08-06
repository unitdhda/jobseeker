import type { VacancyCandidateInput } from '@jobseeker/engine/contracts';
import { createSourceHttp, type SourceHttp, type SourceUrlPolicy } from './http.ts';

export interface SourceLimits {
  searchNewVacancyLimit: number;
  searchPageBudgetPerPlatform: number;
}

/** Collection-wide ports and limits. Provider-specific settings belong to provider factory options. */
export interface SourcesOptions {
  limits: SourceLimits;
  trace(event: string, data?: unknown): void;
  errorMessage(error: unknown): string;
  recordListingCandidate(input: VacancyCandidateInput): Promise<boolean>;
}

export interface SourceContext extends SourcesOptions {
  readonly http: SourceHttp;
}

export function createSourceContext(options: SourcesOptions, urlPolicy: SourceUrlPolicy): SourceContext {
  return { ...options, http: createSourceHttp(urlPolicy) };
}
