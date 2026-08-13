import * as v from 'valibot';
import type { PlatformValidationTemplate } from '@jobseeker/sources';

const label = v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(100));
export const textSearchProfileSchema = v.strictObject({
  version: v.literal(1),
  searches: v.pipe(v.array(v.strictObject({
    name: label,
    rationale: v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(300)),
    query: label,
  })), v.maxLength(8)),
});
export type TextSearchProfile = v.InferOutput<typeof textSearchProfileSchema>;
export type TextSearch = TextSearchProfile['searches'][number];

export function textSearchTemplate(id: string, name: string, language: string, rules: readonly string[] = []): PlatformValidationTemplate {
  return {
    platform: id, version: 1, purpose: `Generate title searches for ${name}.`,
    jsonShape: { version: 1, searches: [{ name: 'CV track', rationale: 'Direct CV evidence', query: 'role title' }] },
    capabilities: { maxSearches: 8, queryLanguage: language },
    rules: ['Return at most 8 searches.', 'Use one concise role title per query.',
      'Do not include salary, location, or work-format terms.', ...rules],
  };
}

export default function register(): void {}
