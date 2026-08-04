/**
 * The cycle-level search plan.
 *
 * Search profiles belong to users, but `vacancies` is shared, so two users asking for equivalent roles used to
 * cost two fetches of the same listing page and half the value of each. The planner folds every user's searches
 * for one platform into clusters of equivalent queries: a cluster is fetched once and its listings are recorded
 * for every user that asked for it, under that user's own search name so per-user prefilter scoring is unchanged.
 *
 * Boards that publish their whole listing regardless of the query are planned as one job for the same reason —
 * enumerating them once per user re-read identical pages — so they receive every cluster at once instead of a
 * rotated slice.
 */
import { config } from '../config.ts';

export interface SearchRecipient { userId: string; searchName: string }
export interface PlannedSearch<T> { search: T; recipients: SearchRecipient[] }
export interface SearchPlan<T> { searches: PlannedSearch<T>[] }
export interface UserSearches<T> { userId: string; searches: readonly T[] }
export interface PlanOptions {
  /** The platform lists everything it has whatever the query, so one job covers every cluster. */
  enumerates?: boolean;
  /** The platform accepts boolean text, so a cluster becomes one OR query rather than its broadest member. */
  mergeText?: 'or';
}

/** hh.ru caps search text at 300 characters, and the profile schema enforces it. */
const mergedTextLimit = 280;

/**
 * Role vocabulary that makes an English and a Russian spelling of the same job cluster together. This is a recall
 * heuristic on top of token overlap, not a translator: a term only ever collapses onto a shared marker, so an
 * unlisted word simply keeps itself and clusters by literal overlap.
 */
const roleMarkers: Record<string, string> = {
  разработчик: 'dev', разработка: 'dev', разработке: 'dev', developer: 'dev', development: 'dev',
  программист: 'dev', engineer: 'dev', engineering: 'dev', инженер: 'dev', инженерия: 'dev',
  бэкенд: 'backend', бекенд: 'backend', backend: 'backend', серверный: 'backend',
  фронтенд: 'frontend', фронтэнд: 'frontend', frontend: 'frontend',
  фулстек: 'fullstack', фулстак: 'fullstack', фуллстек: 'fullstack', fullstack: 'fullstack', stack: 'fullstack',
  машинного: 'ml', обучения: 'ml', обучению: 'ml', machine: 'ml', learning: 'ml', ml: 'ml', мл: 'ml',
  компьютерного: 'vision', зрения: 'vision', computer: 'vision', vision: 'vision', cv: 'vision',
  искусственного: 'ai', интеллекта: 'ai', ai: 'ai', ии: 'ai',
  данных: 'data', data: 'data', дата: 'data', сайентист: 'scientist', scientist: 'scientist',
  аналитик: 'analyst', analyst: 'analyst', аналитике: 'analyst', анализу: 'analysis', analysis: 'analysis',
  исследователь: 'research', исследований: 'research', research: 'research', researcher: 'research',
  научный: 'research', сотрудник: 'research',
  руководитель: 'lead', тимлид: 'lead', лид: 'lead', lead: 'lead', team: 'lead', команды: 'lead', группы: 'lead',
  дизайнер: 'designer', designer: 'designer', design: 'designer', дизайна: 'designer',
  директор: 'director', director: 'director', арт: 'art', art: 'art',
  продуктовый: 'product', product: 'product', моушн: 'motion', motion: 'motion',
  коммуникационный: 'communication', communication: 'communication',
  преподаватель: 'teacher', наставник: 'teacher', mentor: 'teacher', teacher: 'teacher',
  веб: 'web', web: 'web', мобильный: 'mobile', mobile: 'mobile',
  приложений: 'app', приложения: 'app', application: 'app', applications: 'app', app: 'app',
};

/**
 * Grade words are dropped before clustering: a senior and a middle listing of the same role come from the same
 * search page, so keeping them apart would fetch that page twice.
 */
const gradeWords = new Set([
  'junior', 'middle', 'senior', 'principal', 'chief', 'head', 'staff', 'intern', 'младший', 'средний', 'старший',
  'ведущий', 'главный', 'стажер', 'стажёр',
]);
const noiseWords = new Set(['or', 'and', 'и', 'или', 'the', 'a', 'по', 'для', 'с', 'в', 'на', 'специалист']);

export function searchTokens(text: string): Set<string> {
  const tokens = text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}+#.]{2,}/gu) ?? [];
  return new Set(tokens
    .map((token) => token.replace(/^[.]+|[.]+$/g, ''))
    .filter((token) => token.length > 1 && !gradeWords.has(token) && !noiseWords.has(token))
    .map((token) => roleMarkers[token] ?? token));
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return left.size === right.size ? 1 : 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection++;
  return intersection / (left.size + right.size - intersection);
}

interface Entry<T> { userId: string; search: T; name: string; text: string; signature: string; tokens: Set<string> }

/**
 * Everything except the free-text query identifies which listing page a search opens — hh's areas and filters,
 * HireHi's facet and specialization. Only searches whose non-text fields agree may merge, because merging across
 * them would silently widen or narrow somebody's filter.
 */
function entryOf<T>(userId: string, search: T): Entry<T> {
  const record = (search ?? {}) as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name : '';
  const text = typeof record.text === 'string' ? record.text
    : typeof record.query === 'string' ? record.query : '';
  const signature = JSON.stringify(Object.entries(record)
    .filter(([key]) => !['name', 'rationale', 'text', 'query'].includes(key))
    .sort(([left], [right]) => (left < right ? -1 : 1)));
  return { userId, search, name, text, signature, tokens: searchTokens(text) };
}

function clusterEntries<T>(entries: Entry<T>[], similarity: number): Entry<T>[][] {
  const clusters: { signature: string; tokens: Set<string>; members: Entry<T>[] }[] = [];
  for (const entry of entries) {
    const match = clusters.find((cluster) => cluster.signature === entry.signature
      && jaccard(cluster.tokens, entry.tokens) >= similarity);
    if (match) match.members.push(entry);
    else clusters.push({ signature: entry.signature, tokens: entry.tokens, members: [entry] });
  }
  return clusters.map((cluster) => cluster.members);
}

function mergeCluster<T>(members: Entry<T>[], options: PlanOptions): PlannedSearch<T> {
  // The shortest query is the broadest one, so it is the safest single representative of the whole cluster.
  const ordered = [...members].sort((left, right) =>
    left.text.length - right.text.length || (left.text < right.text ? -1 : 1));
  const base = ordered[0]!;
  let search = base.search;
  if (options.mergeText === 'or' && base.text) {
    const texts: string[] = [];
    for (const entry of ordered) {
      if (!entry.text || texts.includes(entry.text)) continue;
      if ([...texts, entry.text].join(' OR ').length > mergedTextLimit) continue;
      texts.push(entry.text);
    }
    if (texts.length > 1) search = { ...(base.search as object), text: texts.join(' OR ') } as T;
  }
  const recipients: SearchRecipient[] = [];
  for (const entry of members) {
    if (recipients.some((recipient) => recipient.userId === entry.userId)) continue;
    recipients.push({ userId: entry.userId, searchName: entry.name || base.name });
  }
  return { search, recipients };
}

/**
 * Rotation now walks one shared cluster list per platform rather than each user's own searches, so every user is
 * served by whichever clusters they belong to and the whole list is swept in `ceil(clusters / budget)` cycles —
 * never slower than the per-user rotation it replaces.
 */
export function rotatedClusters<T>(clusters: readonly T[], platformId: string, budget: number, now: number): T[] {
  if (clusters.length <= budget) return [...clusters];
  let seed = 0;
  for (const character of platformId) seed = (seed * 31 + character.charCodeAt(0)) >>> 0;
  const bucket = Math.floor(now / (config.searchRotationMinutes * 60_000));
  const offset = (seed + bucket * budget) % clusters.length;
  return Array.from({ length: budget }, (_unused, index) => clusters[(offset + index) % clusters.length]!);
}

export function planPlatformSearches<T>(platformId: string, demands: readonly UserSearches<T>[],
  options: PlanOptions = {}, now = Date.now()): SearchPlan<T> {
  // Clustering is greedy, so a stable input order keeps the plan — and therefore the rotation — deterministic.
  const entries = demands.flatMap(({ userId, searches }) => searches.map((search) => entryOf(userId, search)))
    .sort((left, right) => left.signature.localeCompare(right.signature)
      || [...left.tokens].sort().join(' ').localeCompare([...right.tokens].sort().join(' '))
      || left.text.localeCompare(right.text) || left.userId.localeCompare(right.userId));
  const merged = clusterEntries(entries, config.searchClusterSimilarity / 100)
    .map((members) => mergeCluster(members, options));
  if (!merged.length) return { searches: [] };
  if (options.enumerates) return { searches: merged };
  const budget = Math.max(1, demands.length * config.searchQueriesPerCycle);
  return { searches: rotatedClusters(merged, platformId, budget, now) };
}
