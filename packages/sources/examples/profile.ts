import * as v from 'valibot';
import type { PlatformValidationTemplate } from '@jobseeker/sources';

const label = v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(100));
export const companySearchProfileSchema = v.strictObject({
  version: v.literal(1),
  searches: v.pipe(v.array(v.strictObject({
    name: label,
    rationale: v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(300)),
    query: label,
  })), v.maxLength(8)),
});

export type CompanySearch = v.InferOutput<typeof companySearchProfileSchema>['searches'][number];

export function companySearchTemplate(id: string, employer: string): PlatformValidationTemplate {
  return {
    platform: id,
    version: 1,
    purpose: `Public first-party vacancies operated by ${employer}.`,
    jsonShape: {
      version: 1,
      searches: [{ name: 'CV track', rationale: 'Direct CV evidence', query: 'one role title' }],
    },
    capabilities: { query: 'One concise Russian or established English technical role title', maxSearches: 8 },
    rules: [
      'Each query contains one role title without boolean syntax, slashes, pipes, or parentheses.',
      'Put translations and alternative titles in separate searches.',
      'Do not add adjacent occupations, generic industries, location, salary, or work-format terms.',
    ],
  };
}

/** A shared helper, not a provider: the loader imports every module here, so this default export is a deliberate no-op. */
export default function register(): void {}
