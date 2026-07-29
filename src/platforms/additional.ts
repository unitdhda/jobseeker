import * as v from 'valibot';
import type { SearchPlatform } from './types.ts';

const name = v.pipe(v.string(), v.minLength(2), v.maxLength(80));
const rationale = v.pipe(v.string(), v.minLength(2), v.maxLength(300));
const query = v.pipe(v.string(), v.minLength(2), v.maxLength(100));

export const textSearchProfileSchema = v.strictObject({
  version: v.literal(1),
  searches: v.pipe(v.array(v.strictObject({ name, rationale, query })), v.minLength(2), v.maxLength(8)),
});
export type TextSearchProfile = v.InferOutput<typeof textSearchProfileSchema>;

export const getmatchSearchProfileSchema = v.strictObject({
  version: v.literal(1),
  searches: v.pipe(v.array(v.strictObject({
    name, rationale,
    query: v.pipe(query, v.regex(/^[a-z0-9-]+$/, 'Use a lower-case Getmatch vacancy-slug fragment')),
  })), v.minLength(2), v.maxLength(8)),
});
export type GetmatchSearchProfile = v.InferOutput<typeof getmatchSearchProfileSchema>;

const avitoQueries = ['информационные технологии', 'программист', 'web-программист', 'программист python', 'проект-менеджер'] as const;
export const avitoSearchProfileSchema = v.strictObject({
  version: v.literal(1),
  searches: v.pipe(v.array(v.strictObject({ name, rationale, query: v.picklist(avitoQueries) })), v.minLength(1), v.maxLength(5)),
});
export type AvitoSearchProfile = v.InferOutput<typeof avitoSearchProfileSchema>;

function textPlatform(id: string, platformName: string, purpose: string, rules: string[]): SearchPlatform<typeof textSearchProfileSchema> {
  return {
    id, name: platformName, schema: textSearchProfileSchema,
    template: () => ({
      platform: id, version: 1, purpose,
      jsonShape: { version: 1, searches: [{ name: 'short unique label', rationale: 'why it adds coverage', query: 'frontend developer' }] },
      capabilities: { query: 'A concise role or technology phrase supported by the candidate CV', maxSearches: 8 },
      rules: [
        'Use concise role phrases rather than long boolean expressions.',
        'Every query must be supported by concrete CV evidence.',
        'Prefer complementary role families and common Russian/English title variants.',
        'Do not add salary, location, seniority, or work-format words unless explicitly supported.',
        ...rules,
      ],
    }),
  };
}

export const habrPlatform = textPlatform('habr', 'Habr Career',
  'Validated public Habr Career vacancy searches.', ['Use titles and technology terms commonly found in Russian IT vacancies.']);
export const geekjobPlatform = textPlatform('geekjob', 'GeekJob',
  'Validated public GeekJob vacancy searches.', ['Keep each query broad enough for the relatively small curated vacancy board.']);
export const rabotaPlatform = textPlatform('rabota', 'Работа.ру',
  'Validated public Работа.ру SEO role pages.', ['Prefer Russian role names because they become SEO path segments.']);
export const superjobPlatform = textPlatform('superjob', 'SuperJob API',
  'Validated keywords for the official SuperJob API.', ['Prefer Russian role names; this source requires SUPERJOB_API_KEY.']);

export const getmatchPlatform: SearchPlatform<typeof getmatchSearchProfileSchema> = {
  id: 'getmatch', name: 'getmatch', schema: getmatchSearchProfileSchema,
  template: () => ({
    platform: 'getmatch', version: 1,
    purpose: 'Vacancy-title slug fragments used to select recent public vacancy pages from the getmatch sitemap without using its robots-disallowed API.',
    jsonShape: { version: 1, searches: [{ name: 'frontend', rationale: 'target role family', query: 'frontend' }] },
    capabilities: {
      examples: ['frontend', 'backend', 'fullstack', 'node', 'typescript', 'python', 'golang', 'java', 'data', 'ml', 'ai', 'product', 'system-analyst'],
    },
    rules: [
      'query must be a lower-case ASCII fragment likely to occur in a vacancy URL slug.',
      'Use one distinctive role or technology fragment per search.',
      'Every fragment must be supported by concrete CV evidence.',
      'Prefer role fragments over generic words such as developer or engineer.',
    ],
  }),
};

export const avitoPlatform: SearchPlatform<typeof avitoSearchProfileSchema> = {
  id: 'avito', name: 'Avito Работа', schema: avitoSearchProfileSchema,
  template: () => ({
    platform: 'avito', version: 1,
    purpose: 'Allowed public Avito vacancy category and SEO tag pages; disallowed search/API routes are not used.',
    jsonShape: { version: 1, searches: [{ name: 'IT category', rationale: 'broad technology coverage', query: 'информационные технологии' }] },
    capabilities: { queries: avitoQueries },
    rules: [
      'Use only listed queries.',
      'Always include информационные технологии for a technology CV.',
      'Add narrower tags only when relevant to the CV.',
    ],
  }),
};
