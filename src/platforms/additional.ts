import * as v from 'valibot';
import type { SearchPlatform } from './types.ts';

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

function textPlatform(id: 'habr' | 'rabota', name: string, rules: string[]): SearchPlatform<typeof textSearchProfileSchema> {
  return {
    id, name, schema: textSearchProfileSchema,
    template: () => ({
      platform: id,
      version: 1,
      purpose: `Public ${name} vacancy search.`,
      jsonShape: { version: 1, searches: [{ name: 'CV track', rationale: 'Direct CV evidence', query: 'one role title' }] },
      capabilities: { query: 'One concise role title supported by a CV-derived career track', maxSearches: 8 },
      rules: [
        'Each query contains one role title in the language expected by the platform.',
        'Put translations and alternative titles in separate searches.',
        'Do not combine titles with slash, pipe, parentheses, or boolean syntax.',
        'Do not add adjacent occupations, generic industries, location, salary, or work-format terms.',
        ...rules,
      ],
    }),
  };
}

export const habrPlatform = textPlatform('habr', 'Habr Career', [
  'Use Russian or established English vacancy titles that occur on Habr Career.',
]);
export const rabotaPlatform = textPlatform('rabota', 'Работа.ру', [
  'Use Russian role titles because the query becomes an SEO path segment.',
]);
