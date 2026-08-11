/**
 * The application's live word-rarity state: built from the adverts already in the database, persisted so every
 * process agrees, held in memory as the lookups the prefilter consults at compare time.
 *
 * Deliberately the same shape as `role-equivalence.ts` — same refresh points (engine-loop start and daily
 * matching-vocabulary maintenance), same failure posture. A failed rebuild keeps the previous vocabulary; a vocabulary that has
 * never been built leaves the rarity features unmeasured, which the prefilter reports as null rather than zero.
 */
import {
  buildIdfVocabulary, canonicalRoleToken, createIdfLookup, uniformIdfLookups,
  type IdfLookups, type IdfVocabulary,
} from '@jobseeker/engine';
import { loadIdfVocabulary, replaceIdfVocabulary, vacancyTextBatch } from './postgres.ts';
import { roleTokenResolver } from './role-equivalence.ts';
import { errorMessage } from './observability.ts';

let lookups: IdfLookups = uniformIdfLookups;

export function idfLookups(): IdfLookups {
  return lookups;
}

/**
 * The tokenizers, kept here rather than in the engine because they must match the prefilter's own byte for
 * byte — the vocabulary is only meaningful for the tokens it will later be asked about.
 */
const stop = new Set([
  'and', 'the', 'with', 'for', 'from', 'that', 'this', 'into', 'или', 'для', 'как', 'что', 'при', 'это', 'его',
  'она', 'они', 'работа', 'опыт', 'года', 'лет', 'years', 'year', 'experience', 'work', 'team', 'команда',
  'задачи', 'требования',
]);
const seniority = new Set([
  'intern', 'internship', 'junior', 'middle', 'senior', 'lead', 'head', 'principal', 'chief', 'стажер', 'стажёр',
  'младший', 'средний', 'старший', 'ведущий', 'главный', 'руководитель',
]);

function words(input: string): string[] {
  return input.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}+#.]{2,}/gu)
    ?.map((token) => token.replace(/^\.+|\.+$/g, ''))
    .filter((token) => token.length > 1 && !stop.has(token)) ?? [];
}

function titleTokens(input: string, resolve: (token: string) => string): string[] {
  return words(input).filter((token) => !seniority.has(token))
    .map((token) => resolve(canonicalRoleToken(token)));
}

const rebuildBatchSize = 500;

/** Rereads both vocabularies from storage without rebuilding — cheap enough for process start. */
export async function loadIdfLookups(): Promise<void> {
  const [title, body] = await Promise.all([loadIdfVocabulary('title'), loadIdfVocabulary('body')]);
  lookups = {
    title: title ? createIdfLookup(title) : uniformIdfLookups.title,
    body: body ? createIdfLookup(body) : uniformIdfLookups.body,
  };
}

/**
 * Rebuilds both vocabularies from every advert on file and persists them.
 *
 * Streamed in batches: the corpus is tens of megabytes of advert text and there is no reason for all of it to
 * be resident at once. Only the document-frequency counters are kept across batches.
 */
export async function refreshIdfVocabularies(): Promise<{ title: number; body: number; documents: number }> {
  const resolve = roleTokenResolver();
  const titleDocuments: string[][] = [];
  const bodyDocuments: string[][] = [];
  let afterId = 0;
  for (;;) {
    const batch = await vacancyTextBatch(afterId, rebuildBatchSize);
    if (!batch.length) break;
    for (const vacancy of batch) {
      titleDocuments.push([...new Set(titleTokens(vacancy.name, resolve))]);
      bodyDocuments.push([...new Set(
        words(`${vacancy.name}\n${vacancy.description}\n${vacancy.keySkills.join(' ')}`))]);
    }
    afterId = batch.at(-1)!.id;
  }
  const title: IdfVocabulary = buildIdfVocabulary(titleDocuments);
  const body: IdfVocabulary = buildIdfVocabulary(bodyDocuments);
  await replaceIdfVocabulary('title', title);
  await replaceIdfVocabulary('body', body);
  lookups = { title: createIdfLookup(title), body: createIdfLookup(body) };
  return { title: title.entries.length, body: body.entries.length, documents: title.documents };
}

export async function tryRefreshIdfVocabularies(): Promise<void> {
  try {
    const built = await refreshIdfVocabularies();
    console.info(`Word rarity refreshed from ${built.documents} adverts: `
      + `${built.title} title tokens, ${built.body} body tokens.`);
  } catch (error) {
    console.error(`Word-rarity refresh failed; keeping the previous vocabulary: ${errorMessage(error)}`);
  }
}
