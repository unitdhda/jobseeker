const tokenPattern =
  /(?:\.[\p{L}\p{N}]+|[\p{L}\p{N}](?:[\p{L}\p{N}+#]|\.(?=[\p{L}\p{N}]))*)/gu;

/** Structural seniority modifiers, never occupational aliases. */
const gradeWords = new Set([
  'intern',
  'internship',
  'junior',
  'jr',
  'middle',
  'mid',
  'senior',
  'sr',
  'staff',
  'principal',
  'lead',
  'head',
  'chief',
  'стажер',
  'стажёр',
  'младший',
  'средний',
  'старший',
  'ведущий',
  'главный',
]);

/** Grammatical and explicitly generic words; corpus-derived IDF handles domain relevance. */
const lowInformationWords = new Set([
  'a',
  'an',
  'and',
  'at',
  'for',
  'in',
  'of',
  'or',
  'the',
  'to',
  'в',
  'для',
  'и',
  'или',
  'на',
  'по',
  'professional',
  'specialist',
  'специалист',
  'team',
  'tech',
  'technical',
  'команда',
  'команды',
  'технический',
]);

const minimumNgramSize = 3;
const maximumNgramSize = 4;

function normalizeText(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

/**
 * Retains the assignment's public name but performs lexical normalization only.
 * Runtime-learned semantic equivalence must never affect this result.
 */
export function canonicalRoleToken(token: string): string {
  return normalizeText(token).trim();
}

function isUsableToken(token: string): boolean {
  const length = Array.from(token).length;
  return length > 1 || token.includes('+') || token.includes('#') || token.startsWith('.');
}

/**
 * Returns deterministic normalized words for content-addressed identity. Grades are removed only when another
 * substantive token remains, preserving titles such as "Lead" and "Team Lead" rather than producing no identity.
 */
export function searchTokens(text: string): Set<string> {
  const lexicalTokens = normalizeText(text).match(tokenPattern) ?? [];
  const informativeTokens = lexicalTokens
    .map(canonicalRoleToken)
    .filter((token) => isUsableToken(token) && !lowInformationWords.has(token));
  const tokensWithoutGrades = informativeTokens.filter((token) => !gradeWords.has(token));
  const selectedTokens = tokensWithoutGrades.length > 0 ? tokensWithoutGrades : informativeTokens;
  return new Set(selectedTokens);
}

function ngramsOf(tokens: Iterable<string>): Set<string> {
  const result = new Set<string>();

  for (const rawToken of tokens) {
    const token = canonicalRoleToken(rawToken);
    if (!token) continue;

    const characters = Array.from(`^${token}$`);
    let emitted = false;

    for (let size = minimumNgramSize; size <= maximumNgramSize; size += 1) {
      if (characters.length < size) continue;

      for (let index = 0; index <= characters.length - size; index += 1) {
        result.add(`${size}:${characters.slice(index, index + size).join('')}`);
        emitted = true;
      }
    }

    if (!emitted) result.add(`exact:${token}`);
  }

  return result;
}

/**
 * Morphology-tolerant Jaccard similarity for comparison and one-time unit adoption only. N-grams are deliberately
 * private so callers cannot persist them as identity or silently choose incompatible policies.
 */
export function roleNgramSimilarity(leftTokens: Iterable<string>, rightTokens: Iterable<string>): number {
  const left = ngramsOf(leftTokens);
  const right = ngramsOf(rightTokens);

  if (left.size === 0 || right.size === 0) return left.size === right.size ? 1 : 0;

  let intersection = 0;
  for (const feature of left) if (right.has(feature)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}
