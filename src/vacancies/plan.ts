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
import type { PlanOptions, PlannedSearch, SearchPlan, SearchRecipient, UserSearches } from '@jobseeker/sources';
import { searchTokens } from '@jobseeker/engine';

export { searchTokens };

// The plan shapes live with their consumer, the sources contract; the planner produces what adapters accept.
export type { PlanOptions, PlannedSearch, SearchPlan, SearchRecipient, UserSearches };

/** hh.ru caps search text at 300 characters, and the profile schema enforces it. */
const mergedTextLimit = 280;


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
 * Selects the cycle's clusters user by user instead of slicing the similarity-sorted list. Clusters sort next to
 * their owner's other searches — one user's vocabulary — so a contiguous window used to land inside one or two
 * users' runs and leave the rest with nothing for whole cycles. Each round gives every user their next cluster
 * (advancing one step per rotation bucket, so successive cycles sweep each user's own list), and rounds repeat
 * until the budget is spent. A shared cluster picked for one user covers its other recipients for free, which is
 * the clustering economy paying out as spare budget rather than as lost coverage.
 */
export function rotatedClusters<T>(merged: readonly PlannedSearch<T>[], platformId: string,
  budget: number, now: number): PlannedSearch<T>[] {
  if (merged.length <= budget) return [...merged];
  let seed = 0;
  for (const character of platformId) seed = (seed * 31 + character.charCodeAt(0)) >>> 0;
  const bucket = Math.floor(now / (config.searchRotationMinutes * 60_000));
  const byUser = new Map<string, number[]>();
  merged.forEach((search, index) => {
    for (const { userId } of search.recipients) {
      const list = byUser.get(userId) ?? [];
      list.push(index);
      byUser.set(userId, list);
    }
  });
  const users = [...byUser.keys()].sort();
  const picked = new Set<number>();
  const target = Math.min(budget, merged.length);
  for (let round = 0; picked.size < target; round++) {
    const before = picked.size;
    for (const userId of users) {
      if (picked.size >= target) break;
      const list = byUser.get(userId)!;
      picked.add(list[(seed + bucket * config.searchQueriesPerCycle + round) % list.length]!);
    }
    // Every pointer has wrapped onto already-picked clusters; only possible once everything is picked.
    if (picked.size === before) break;
  }
  return [...picked].sort((left, right) => left - right).map((index) => merged[index]!);
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
  // At least one pick per user per cycle by construction: the budget scales with the users demanding, and the
  // rotation serves users before it serves breadth.
  const budget = Math.max(1, demands.length * config.searchQueriesPerCycle);
  return { searches: rotatedClusters(merged, platformId, budget, now) };
}
