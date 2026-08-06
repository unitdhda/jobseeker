/**
 * The contract between the app's planner and the source adapters. The plan shapes live here — with their consumer —
 * so the planner produces what the adapters declare they accept, not the other way round.
 */
import type { BaseIssue, BaseSchema, InferOutput } from 'valibot';
import type { SearchPlan, VacancyCandidate, VacancyInput } from '@jobseeker/engine/contracts';

export type { PlannedSearch, SearchPlan, SearchRecipient } from '@jobseeker/engine/contracts';
export interface UserSearches<T> { userId: string; searches: readonly T[] }
export interface PlanOptions {
  /** The platform lists everything it has whatever the query, so one job covers every cluster. */
  enumerates?: boolean;
  /** The platform accepts boolean text, so a cluster becomes one OR query rather than its broadest member. */
  mergeText?: 'or';
}

export interface PlatformValidationTemplate {
  platform: string;
  version: number;
  purpose: string;
  jsonShape: unknown;
  capabilities: Record<string, unknown>;
  rules: string[];
}

export interface SearchPlatform<S extends BaseSchema<unknown, unknown, BaseIssue<unknown>>> {
  id: string;
  name: string;
  schema: S;
  template(): PlatformValidationTemplate;
  /** Every host this platform is allowed to touch; the union feeds the SSRF guard at registration. */
  hosts: readonly string[];
  /** The platform lists everything it has whatever the query, so its plan is one job covering every cluster. */
  enumerates?: boolean;
  /** The platform accepts boolean text, so a cluster of equivalent queries becomes one OR search. */
  mergeText?: 'or';
}

export type PlatformProfile<P extends SearchPlatform<BaseSchema<unknown, unknown, BaseIssue<unknown>>>> =
  InferOutput<P['schema']>;

export interface PlatformDiscoveryResult { searches: number; users: number; seen: number; discovered: number;
  discoveredBySearch?: Record<string, number> }
export type PlatformSearch<S extends BaseSchema<unknown, unknown, BaseIssue<unknown>>> =
  InferOutput<S> extends { searches: readonly (infer T)[] } ? T : never;
export interface VacancyPlatform<S extends BaseSchema<unknown, unknown, BaseIssue<unknown>>> extends SearchPlatform<S> {
  discover(plan: SearchPlan<PlatformSearch<S>>): Promise<PlatformDiscoveryResult>;
  normalize(candidates: VacancyCandidate[]): Promise<Map<string, VacancyInput | null | Error>>;
}
