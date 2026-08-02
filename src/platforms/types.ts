import type { BaseIssue, BaseSchema, InferOutput } from 'valibot';
import type { VacancyCandidate, VacancyInput } from '../lib/database-types.ts';

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
}

export type PlatformProfile<P extends SearchPlatform<BaseSchema<unknown, unknown, BaseIssue<unknown>>>> =
  InferOutput<P['schema']>;

export interface PlatformDiscoveryResult { searches: number; seen: number; discovered: number }
export interface VacancyPlatform<S extends BaseSchema<unknown, unknown, BaseIssue<unknown>>> extends SearchPlatform<S> {
  discover(userId: string, profile: InferOutput<S>): Promise<PlatformDiscoveryResult>;
  normalize(candidates: VacancyCandidate[]): Promise<Map<string, VacancyInput | null | Error>>;
}
