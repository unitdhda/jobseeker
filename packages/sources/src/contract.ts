import type { BaseIssue, BaseSchema, InferOutput } from 'valibot';
import type {
  SearchPlan,
  VacancyCandidate,
  VacancyInput,
} from '@jobseeker/engine/contracts';

export type { PlannedSearch, SearchPlan, SearchRecipient } from '@jobseeker/engine/contracts';

export interface UserSearches<T> {
  readonly userId: string;
  readonly searches: readonly T[];
}

export interface PlanOptions {
  readonly enumerates?: boolean;
  readonly mergeText?: 'or';
}

export interface PlatformValidationTemplate {
  readonly platform: string;
  readonly version: number;
  readonly purpose: string;
  readonly jsonShape: unknown;
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly rules: readonly string[];
}

export type SourceSchema = BaseSchema<unknown, unknown, BaseIssue<unknown>>;

export interface SearchPlatform<S extends SourceSchema> {
  readonly id: string;
  readonly name: string;
  readonly schema: S;
  template(): PlatformValidationTemplate;
  /** Closed host declaration consumed by the URL and SSRF boundary. */
  readonly hosts: readonly string[];
  readonly enumerates?: boolean;
  readonly mergeText?: 'or';
}

export type PlatformProfile<P extends SearchPlatform<SourceSchema>> = InferOutput<P['schema']>;

export type PlatformSearch<S extends SourceSchema> =
  InferOutput<S> extends { readonly searches: readonly (infer T)[] } ? T : never;

export interface PlatformDiscoveryResult {
  readonly searches: number;
  readonly users: number;
  readonly seen: number;
  readonly discovered: number;
  readonly discoveredBySearch?: Readonly<Record<string, number>>;
}

export interface VacancyPlatform<S extends SourceSchema> extends SearchPlatform<S> {
  discover(plan: SearchPlan<PlatformSearch<S>>): Promise<PlatformDiscoveryResult>;
  normalize(candidates: readonly VacancyCandidate[]): Promise<Map<string, VacancyInput | null | Error>>;
}
