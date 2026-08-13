export interface IdfEntry {
  readonly token: string;
  readonly idf: number;
}

export interface IdfVocabulary {
  readonly entries: readonly IdfEntry[];
  readonly documents: number;
  readonly unknownIdf: number;
}

export interface IdfLookup {
  readonly unknownIdf: number;
  readonly documents: number;
  readonly size: number;
  of(token: string): number;
}

export interface IdfLookups {
  readonly title: IdfLookup;
  readonly body: IdfLookup;
}

const floatingTolerance = 1e-12;

function normalizeToken(token: string): string {
  return token.normalize('NFKC').toLowerCase().trim();
}

function idfFor(documents: number, seenIn: number): number {
  return Math.log((documents + 1) / (seenIn + 0.5));
}

export const uniformIdfLookup: IdfLookup = Object.freeze({
  of: (_token: string) => 1,
  unknownIdf: 1,
  documents: 0,
  size: 0,
});

export const uniformIdfLookups: IdfLookups = Object.freeze({
  title: uniformIdfLookup,
  body: uniformIdfLookup,
});

/** Builds compact, deterministic derived vocabulary data from tokenized corpus documents. */
export function buildIdfVocabulary(documents: Iterable<Iterable<string>>): IdfVocabulary {
  const seenIn = new Map<string, number>();
  let documentCount = 0;

  for (const document of documents) {
    documentCount += 1;
    if (!Number.isSafeInteger(documentCount)) {
      throw new RangeError('Invalid IDF corpus: document count exceeds the maximum safe integer.');
    }

    const uniqueTokens = new Set<string>();
    for (const rawToken of document) {
      if (typeof rawToken !== 'string') {
        throw new TypeError('Invalid IDF corpus token: expected a string.');
      }
      const token = normalizeToken(rawToken);
      if (!token) throw new TypeError('Invalid IDF corpus token: tokens must not be empty.');
      uniqueTokens.add(token);
    }
    for (const token of uniqueTokens) seenIn.set(token, (seenIn.get(token) ?? 0) + 1);
  }

  if (documentCount === 0) {
    return Object.freeze({ entries: Object.freeze([]), documents: 0, unknownIdf: 1 });
  }

  const unknownIdf = idfFor(documentCount, 1);
  const entries: IdfEntry[] = [];
  for (const [token, count] of seenIn) {
    if (count === 1) continue;
    entries.push(Object.freeze({ token, idf: idfFor(documentCount, count) }));
  }
  entries.sort((left, right) => left.token < right.token ? -1 : left.token > right.token ? 1 : 0);
  return Object.freeze({ entries: Object.freeze(entries), documents: documentCount, unknownIdf });
}

/** Validates persisted vocabulary data before turning it into executable lookup behavior. */
export function createIdfLookup(vocabulary: IdfVocabulary): IdfLookup {
  if (!Number.isSafeInteger(vocabulary.documents) || vocabulary.documents < 0) {
    throw new RangeError(
      `Invalid IDF vocabulary: documents must be a nonnegative safe integer, received ${vocabulary.documents}.`,
    );
  }
  if (vocabulary.documents === 0) return uniformIdfLookup;
  if (!Number.isFinite(vocabulary.unknownIdf) || vocabulary.unknownIdf <= 0) {
    throw new RangeError('Invalid IDF vocabulary: unknownIdf must be a finite positive number.');
  }

  const weights = new Map<string, number>();
  for (const entry of vocabulary.entries) {
    if (typeof entry.token !== 'string' || !entry.token) {
      throw new TypeError('Invalid IDF vocabulary entry: token must be a nonempty string.');
    }
    const token = normalizeToken(entry.token);
    if (token !== entry.token) {
      throw new TypeError('Invalid IDF vocabulary entry: token must already be NFKC-normalized and lowercase.');
    }
    if (weights.has(token)) throw new TypeError('Invalid IDF vocabulary: duplicate token encountered.');
    if (!Number.isFinite(entry.idf) || entry.idf <= 0) {
      throw new RangeError('Invalid IDF vocabulary entry: idf must be a finite positive number.');
    }
    if (entry.idf > vocabulary.unknownIdf + floatingTolerance) {
      throw new RangeError('Invalid IDF vocabulary entry: stored idf must not exceed unknownIdf.');
    }
    weights.set(token, entry.idf);
  }

  const unknownIdf = vocabulary.unknownIdf;
  return Object.freeze({
    of: (token: string) => weights.get(normalizeToken(token)) ?? unknownIdf,
    unknownIdf,
    documents: vocabulary.documents,
    size: weights.size,
  });
}

function termCounts(tokens: Iterable<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const rawToken of tokens) {
    const token = normalizeToken(rawToken);
    if (!token) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

export function idfWeightedCosine(
  leftTokens: Iterable<string>,
  rightTokens: Iterable<string>,
  lookup: IdfLookup,
): number {
  const left = termCounts(leftTokens);
  const right = termCounts(rightTokens);
  if (left.size === 0 || right.size === 0) return 0;

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (const [token, count] of left) {
    const weighted = count * lookup.of(token);
    leftMagnitude += weighted * weighted;
    const rightCount = right.get(token);
    if (rightCount !== undefined) dot += weighted * rightCount * lookup.of(token);
  }
  for (const [token, count] of right) {
    const weighted = count * lookup.of(token);
    rightMagnitude += weighted * weighted;
  }
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

export function titleSpecificity(matchedTokens: Iterable<string>, lookup: IdfLookup): number {
  const tokens = new Set([...matchedTokens].map(normalizeToken).filter(Boolean));
  if (tokens.size === 0) return 0;

  let total = 0;
  for (const token of tokens) total += lookup.of(token);
  return Math.min(1, Math.max(0, total / tokens.size / lookup.unknownIdf));
}
