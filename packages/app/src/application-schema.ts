import * as v from 'valibot';
import {
  cvDocumentSchema,
  normalizeCvDocumentJson,
  parseCvText,
  type CvDocument,
} from '@jobseeker/cv/pdf';

export type ApplicationArtifact = 'cv' | 'letter';

export type ParsedApplicationOutput =
  | { readonly artifact: 'cv'; readonly document: CvDocument; readonly source: 'structured' | 'prose' }
  | { readonly artifact: 'letter'; readonly text: string };

const proseCvSchema = v.strictObject({
  artifact: v.literal('cv'),
  text: v.pipe(v.string(), v.trim(), v.minLength(100), v.maxLength(500_000)),
});
const structuredCvSchema = v.strictObject({
  artifact: v.literal('cv'),
  document: cvDocumentSchema,
});
const letterTextSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(80),
  v.maxLength(2_000),
  v.check((text) => text.split(/\n\s*\n/gu).filter(Boolean).length <= 3,
    'Cover letter must contain at most three paragraphs.'),
  v.check((text) => !/^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s)|\*\*|\[[^\]]+\]\([^)]+\)/mu.test(text),
    'Cover letter must be plain text without Markdown headings, bullets, emphasis, or links.'),
  v.check((text) => !/^\s*(?:dear|hello|hi|уважаем|здравствуй|добрый день)\b/iu.test(text),
    'Cover letter must not include a salutation block.'),
  v.check((text) => !/(?:^|\n\s*\n)\s*(?:sincerely|regards|best regards|с уважением)[,!]?\s*(?:\n|$)/iu.test(text),
    'Cover letter must not include a signature block.'),
);
const letterSchema = v.strictObject({ artifact: v.literal('letter'), text: letterTextSchema });
const cvApplicationSchema = v.union([structuredCvSchema, proseCvSchema]);

export function applicationOutputSchema(expectedArtifact: ApplicationArtifact): typeof cvApplicationSchema | typeof letterSchema {
  return expectedArtifact === 'letter' ? letterSchema : cvApplicationSchema;
}

/** Deterministic repair is deliberately limited to structured CV shape drift; prose and letters are never rewritten. */
export function repairApplicationOutput(value: unknown, expectedArtifact: ApplicationArtifact): unknown {
  if (expectedArtifact !== 'cv' || typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return 'document' in record ? { ...record, document: normalizeCvDocumentJson(record.document) } : value;
}

/**
 * Parses exactly the requested artifact. A CV and a letter are independent model calls, limits, cache entries,
 * and outputs; accepting a response for the other artifact would collapse those domain guarantees.
 */
export function parseApplicationOutput(value: unknown, expectedArtifact: ApplicationArtifact): ParsedApplicationOutput {
  if (expectedArtifact === 'letter') {
    const letter = v.parse(letterSchema, value);
    return Object.freeze({ artifact: 'letter', text: letter.text });
  }

  const record = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  if (record?.artifact !== 'cv') {
    throw new TypeError('Invalid application output: expected a CV artifact.');
  }
  if ('document' in record) {
    const repaired = normalizeCvDocumentJson(record.document);
    const parsed = v.parse(structuredCvSchema, { artifact: 'cv', document: repaired });
    return Object.freeze({ artifact: 'cv', document: parsed.document, source: 'structured' });
  }
  const prose = v.parse(proseCvSchema, value);
  return Object.freeze({ artifact: 'cv', document: parseCvText(prose.text), source: 'prose' });
}
