import * as v from 'valibot';
import type { SearchPlatform } from './types.ts';

export const hireHiSpecializations = [
  '1c', 'analytics', 'android', 'backend', 'business-analyst', 'ci-cd', 'cloud', 'cpp',
  'data-analyst', 'data-engineer', 'development', 'devops', 'dotnet', 'frontend', 'fullstack',
  'go', 'iac', 'infrastructure', 'ios', 'java', 'kotlin', 'kubernetes', 'manual-qa', 'ml-ai',
  'mobile', 'nodejs', 'observability', 'php', 'product-analyst', 'product-manager', 'project-manager',
  'python', 'qa', 'qa-automation', 'rust', 'security', 'sre-platform', 'system-analyst',
] as const;

const facets = ['all', 'remote', 'intern', 'junior', 'middle', 'senior', 'lead', 'head'] as const;
const searchSchema = v.strictObject({
  name: v.pipe(v.string(), v.minLength(2), v.maxLength(80)),
  rationale: v.pipe(v.string(), v.minLength(2), v.maxLength(300)),
  specialization: v.picklist(hireHiSpecializations),
  facet: v.picklist(facets),
});

export const hireHiSearchProfileSchema = v.strictObject({
  version: v.literal(1),
  searches: v.pipe(
    v.array(searchSchema),
    v.maxLength(8),
    v.check((searches) => new Set(searches.map((search) => `${search.facet}:${search.specialization}`)).size === searches.length,
      'HireHi searches must use unique facet and specialization pairs'),
  ),
});

export type HireHiSearchProfile = v.InferOutput<typeof hireHiSearchProfileSchema>;
export type HireHiSearch = HireHiSearchProfile['searches'][number];

export const hireHiPlatform: SearchPlatform<typeof hireHiSearchProfileSchema> = {
  id: 'hirehi',
  name: 'HireHi',
  schema: hireHiSearchProfileSchema,
  template: () => ({
    platform: 'hirehi',
    version: 1,
    purpose: 'Validated HireHi SEO landing pages. The scraper reads public server-rendered pages and vacancy JSON-LD, respecting HireHi robots.txt by not using its disallowed search API.',
    jsonShape: {
      version: 1,
      searches: [{
        name: 'Supported CV track',
        rationale: 'direct CV evidence for this specialization',
        specialization: 'one of capabilities.specializations',
        facet: 'all',
      }],
    },
    capabilities: {
      specializations: hireHiSpecializations,
      facets,
      facetMeaning: {
        all: 'all levels and work formats for this specialization',
        remote: 'remote vacancies for this specialization',
        intern: 'intern grade', junior: 'junior grade', middle: 'middle grade',
        senior: 'senior grade', lead: 'lead grade', head: 'head grade',
      },
    },
    rules: [
      'Choose only specialization and facet values listed by this template.',
      'Use all when the CV does not justify a strict seniority or remote-work facet.',
      'Use remote only when remote work is explicit in the CV or operator configuration.',
      'Use a grade facet only when the CV provides clear seniority evidence; include an all-level search when uncertain.',
      'Prefer complementary role families over many narrow seniority variants of one role.',
      'Do not use broad specializations such as development when a more precise supported specialization covers the CV.',
      'Do not substitute an adjacent role when no specialization directly represents a CV-derived career track.',
      'Use an empty searches array when this platform has no compatible specialization.',
    ],
  }),
};

export function hireHiSearchUrl(search: HireHiSearch, page: number): string {
  const path = search.facet === 'all'
    ? `/vacancies/${search.specialization}`
    : `/${search.facet}-${search.specialization}-jobs`;
  const url = new URL(path, 'https://hirehi.ru');
  if (page > 1) url.searchParams.set('page', String(page));
  return url.toString();
}
