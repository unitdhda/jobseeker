/**
 * Learned role-token equivalences, mined from the career profiles the LLM already produces.
 *
 * A track's titleVariants all name the same role — the schema forces translations into separate variants — so
 * variant pairs are labelled equivalence data manufactured as a side effect of profile generation. Mining is
 * precision-first: after canonicalization through the frozen core markers, a pair of variants contributes a
 * token pair only when the alignment is unambiguous — and only across scripts. Same-script residuals are
 * usually adjacent roles the same person holds (frontend|fullstack, python|backend), not names for one role;
 * production profiles proved that merging them conflates occupations. Cross-script residuals of one track are
 * translations with near certainty. Coverage therefore grows with the deployment's actual occupations instead
 * of a curated dictionary, at the cost of ignoring same-language synonyms the core table must cover itself.
 *
 * The learned layer is consulted only at compare time (prefilter evidence, unit adoption). Unit identity hashing
 * keeps using the frozen core alone: late-learned pairs must never re-key existing units.
 */
import { searchTokens } from './canon.ts';

export interface RoleEquivalencePair {
  /** Lexicographically ordered so (a,b) and (b,a) are one fact. */
  tokenA: string;
  tokenB: string;
  support: number;
}

export interface RoleTrackTitles { titleVariants: readonly string[] }

/**
 * Extracts equivalence candidates from tracks. Two rules, both unambiguous by construction:
 * single-token variants of one track pair directly; multi-token variants pair only when they share at least one
 * anchor token and each side leaves exactly one residual.
 */
export function mineRoleEquivalences(tracks: readonly RoleTrackTitles[]): RoleEquivalencePair[] {
  const support = new Map<string, number>();
  const cyrillic = (token: string): boolean => /[Ѐ-ӿ]/.test(token);
  const count = (left: string, right: string): void => {
    if (left === right || cyrillic(left) === cyrillic(right)) return;
    const key = left < right ? `${left}\n${right}` : `${right}\n${left}`;
    support.set(key, (support.get(key) ?? 0) + 1);
  };
  for (const track of tracks) {
    const variants = track.titleVariants.map((variant) => searchTokens(variant)).filter((tokens) => tokens.size > 0);
    for (let first = 0; first < variants.length; first++) {
      for (let second = first + 1; second < variants.length; second++) {
        const a = variants[first]!; const b = variants[second]!;
        if (a.size === 1 && b.size === 1) { count([...a][0]!, [...b][0]!); continue; }
        const residualA = [...a].filter((token) => !b.has(token));
        const residualB = [...b].filter((token) => !a.has(token));
        const anchors = a.size - residualA.length;
        if (anchors >= 1 && residualA.length === 1 && residualB.length === 1) {
          count(residualA[0]!, residualB[0]!);
        }
      }
    }
  }
  return [...support.entries()].map(([key, times]) => {
    const [tokenA, tokenB] = key.split('\n') as [string, string];
    return { tokenA, tokenB, support: times };
  }).sort((left, right) => right.support - left.support || left.tokenA.localeCompare(right.tokenA));
}

/** Maps a token to its equivalence-class representative; unlisted tokens map to themselves. */
export type RoleTokenResolver = (token: string) => string;

export const identityRoleResolver: RoleTokenResolver = (token) => token;

/** Union-find over the learned pairs, collapsed to a representative per class. */
export function createRoleTokenResolver(pairs: readonly Pick<RoleEquivalencePair, 'tokenA' | 'tokenB'>[]):
  RoleTokenResolver {
  const parent = new Map<string, string>();
  const find = (token: string): string => {
    let root = token;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  for (const pair of pairs) {
    for (const token of [pair.tokenA, pair.tokenB]) if (!parent.has(token)) parent.set(token, token);
    const rootA = find(pair.tokenA); const rootB = find(pair.tokenB);
    if (rootA !== rootB) parent.set(rootB < rootA ? rootA : rootB, rootB < rootA ? rootB : rootA);
  }
  const resolved = new Map<string, string>();
  for (const token of parent.keys()) resolved.set(token, find(token));
  return (token) => resolved.get(token) ?? token;
}
