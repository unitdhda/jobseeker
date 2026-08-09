/**
 * How unusual a word is, measured over the adverts this deployment has actually seen.
 *
 * The prefilter's title evidence used to ask only "do these titles share words", which cannot tell a match on
 * "designer" — a word half the board uses — from a match on "communication designer". Measured on production,
 * that is not a nuance: a token-set ratio saturates at 1.0 for 49% of all matches, and that half converts worse
 * (40%) than the band just below it (62%). The top of the scale carried no information at all.
 *
 * Rarity fixes that, and it has to come from the corpus rather than a word list, because which words are common
 * is a property of the boards and occupations a given deployment actually searches.
 *
 * Vocabularies are derived data, rebuilt from `vacancies` on the same daily cadence as role equivalences.
 * Truncating one only flattens the evidence until the next rebuild.
 */

/** A token's weight, and what an unseen token is worth. */
export interface IdfLookup {
  of(token: string): number;
  /** What a token absent from the vocabulary scores — by construction, what a token seen once would score. */
  readonly unknownIdf: number;
  readonly documents: number;
  readonly size: number;
}

export interface IdfEntry { token: string; idf: number }

export interface IdfVocabulary {
  entries: IdfEntry[];
  documents: number;
  unknownIdf: number;
}

/** Smoothed inverse document frequency. The +1/+0.5 keep it finite and positive for every count. */
const idfFor = (documents: number, seenIn: number): number => Math.log((documents + 1) / (seenIn + 0.5));

/**
 * Builds a vocabulary from tokenized documents, keeping only what is worth storing.
 *
 * A token seen in exactly one advert scores the same as a token never seen at all, so the single-document tail
 * is dropped and `unknownIdf` carries its value instead. That is not an approximation: measured over the
 * production corpus the kept and full vocabularies correlate at 1.000000 for title evidence and 0.999951 for
 * the body cosine, and it turns 61,518 body tokens into 36,145 rows.
 */
export function buildIdfVocabulary(documents: Iterable<Iterable<string>>): IdfVocabulary {
  const seenIn = new Map<string, number>();
  let count = 0;
  for (const document of documents) {
    count += 1;
    for (const token of new Set(document)) seenIn.set(token, (seenIn.get(token) ?? 0) + 1);
  }
  const unknownIdf = idfFor(count, 1);
  const entries: IdfEntry[] = [];
  for (const [token, documentCount] of seenIn) {
    if (documentCount < 2) continue;
    entries.push({ token, idf: idfFor(count, documentCount) });
  }
  entries.sort((left, right) => (left.token < right.token ? -1 : left.token > right.token ? 1 : 0));
  return { entries, documents: count, unknownIdf };
}

/** The empty vocabulary: every token equally unusual, so rarity contributes nothing until one is built. */
export const uniformIdfLookup: IdfLookup = { of: () => 1, unknownIdf: 1, documents: 0, size: 0 };

export function createIdfLookup(vocabulary: IdfVocabulary): IdfLookup {
  if (!vocabulary.documents || !vocabulary.entries.length) return uniformIdfLookup;
  const weights = new Map(vocabulary.entries.map((entry) => [entry.token, entry.idf]));
  const unknownIdf = vocabulary.unknownIdf;
  return {
    of: (token) => weights.get(token) ?? unknownIdf,
    unknownIdf,
    documents: vocabulary.documents,
    size: weights.size,
  };
}

/** The two vocabularies the prefilter consults: role tokens from advert titles, and words from advert bodies. */
export interface IdfLookups { title: IdfLookup; body: IdfLookup }

export const uniformIdfLookups: IdfLookups = { title: uniformIdfLookup, body: uniformIdfLookup };
