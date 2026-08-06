import { AsyncLocalStorage } from 'node:async_hooks';
import type { VacancyCandidateInput } from '@jobseeker/engine/contracts';

export interface SourcesSettings {
  searchNewVacancyLimit: number;
  searchPageBudgetPerPlatform: number;
  hhMaxPages: number;
  hhAreaId: string;
  hhBrowserDataPath: string;
  hhOperationTimeoutSeconds: number;
  hireHiMaxPages: number;
  additionalMaxPages: number;
  playwrightHeadless: boolean;
  playwrightChromiumPath: string | undefined;
  timezone: string;
  browserEnvironment: { lang: string; path: string; tmpdir: string };
  atsBoards: readonly string[];
  trudvsemRegion: string | undefined;
}

export interface SourcesOptions {
  settings: SourcesSettings;
  trace(event: string, data?: unknown): void;
  errorMessage(error: unknown): string;
  recordListingCandidate(input: VacancyCandidateInput): Promise<boolean>;
}

export interface SourcesRuntime { readonly options: SourcesOptions }
const currentSources = new AsyncLocalStorage<SourcesRuntime>();

export function createSourcesRuntime(options: SourcesOptions): SourcesRuntime {
  return { options };
}

export function runWithSources<T>(runtime: SourcesRuntime, operation: () => T): T {
  return currentSources.run(runtime, operation);
}

export function currentSourcesRuntime(): SourcesRuntime {
  const value = currentSources.getStore();
  if (!value) throw new Error('A source adapter was called outside its createSourceRegistry instance.');
  return value;
}

export function sourcesSettings(): SourcesSettings {
  return currentSourcesRuntime().options.settings;
}

export const trace = (event: string, data?: unknown): void => currentSourcesRuntime().options.trace(event, data);
export const errorMessage = (error: unknown): string => currentSourcesRuntime().options.errorMessage(error);
export const recordListingCandidate = (input: VacancyCandidateInput): Promise<boolean> =>
  currentSourcesRuntime().options.recordListingCandidate(input);
