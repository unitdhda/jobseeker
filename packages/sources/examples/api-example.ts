import type { VacancyCandidate, VacancyInput } from '@jobseeker/engine/contracts';
import { asObject, hashedVacancy, htmlText, plainText } from './toolkit.ts';

export function path(value: unknown, ...keys: readonly string[]): unknown {
  let current = value;
  for (const key of keys) {
    const object = asObject(current);
    if (!object) return undefined;
    current = object[key];
  }
  return current;
}

export function arrayAt(value: unknown, ...keys: readonly string[]): readonly Record<string, unknown>[] {
  const found = keys.length ? path(value, ...keys) : value;
  return Array.isArray(found) ? found.map(asObject).filter((item): item is Record<string, unknown> => item !== null) : [];
}

export function textAt(value: unknown, ...keys: readonly string[]): string { return plainText(path(value, ...keys)); }
export function dateAt(value: unknown, ...keys: readonly string[]): string | undefined {
  const raw = textAt(value, ...keys); if (!raw) return undefined;
  const date = new Date(raw); return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}
export function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.map(plainText).filter(Boolean) : plainText(value).split(/[,;]/u).map((item) => item.trim()).filter(Boolean);
}

export interface NormalizedApiFields {
  readonly name: string;
  readonly employer: string;
  readonly area: string;
  readonly description: string;
  readonly skills?: readonly string[];
  readonly remote?: boolean;
  readonly closed?: boolean;
  readonly publishedAt?: string;
}

export function apiVacancy(candidate: VacancyCandidate, fields: NormalizedApiFields): VacancyInput | null {
  if (fields.closed) return null;
  const description = htmlText(fields.description);
  if (!fields.name.trim() || description.length < 20) throw new Error(`Source ${candidate.source} returned incomplete vacancy detail.`);
  const publishedAt = fields.publishedAt ? new Date(fields.publishedAt) : candidate.publishedAt;
  if (!Number.isFinite(publishedAt.getTime())) throw new Error(`Source ${candidate.source} returned an invalid publication date.`);
  return hashedVacancy({
    source: candidate.source, sourceId: candidate.sourceId, name: fields.name.trim(),
    employer: fields.employer.trim() || 'Не указано', area: fields.area.trim() || 'Не указано', salary: null,
    experience: { kind: 'unspecified' }, employment: 'unspecified', schedule: 'unspecified',
    workFormat: fields.remote ? 'remote' : 'unspecified', description,
    keySkills: Object.freeze([...(fields.skills ?? [])].slice(0, 30)), url: candidate.url, publishedAt,
    sourceQuery: candidate.searchName,
  });
}

export default function register(): void {}
