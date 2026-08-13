import { roleNgramSimilarity, searchTokens } from './canon.ts';

export interface RoleEquivalencePair {
  readonly tokenA: string;
  readonly tokenB: string;
  readonly support: number;
}

export interface RoleTrackTitles {
  readonly titleVariants: readonly string[];
}

export type RoleTokenResolver = (token: string) => string;

export const identityRoleResolver: RoleTokenResolver = (token) => token;

const anchorNgramThreshold = 0.8;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeToken(token: string): string {
  return token.normalize('NFKC').toLowerCase().trim();
}

type TokenScript = 'latin' | 'cyrillic' | 'unknown';

function tokenScript(token: string): TokenScript {
  const letters = token.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return 'unknown';
  if (letters.every((letter) => /\p{Script=Latin}/u.test(letter))) return 'latin';
  if (letters.every((letter) => /\p{Script=Cyrillic}/u.test(letter))) return 'cyrillic';
  return 'unknown';
}

function crossScript(left: string, right: string): boolean {
  const leftScript = tokenScript(left);
  const rightScript = tokenScript(right);
  return leftScript !== 'unknown' && rightScript !== 'unknown' && leftScript !== rightScript;
}

function anchoredResiduals(
  left: readonly string[],
  right: readonly string[],
): readonly [string, string] | null {
  const remainingRight = new Set(right.map((_token, index) => index));
  const unmatchedLeft: string[] = [];

  for (const leftToken of left) {
    let matchedIndex: number | undefined;
    for (const index of remainingRight) {
      const rightToken = right[index]!;
      if (leftToken === rightToken
        || (tokenScript(leftToken) === tokenScript(rightToken)
          && tokenScript(leftToken) !== 'unknown'
          && roleNgramSimilarity([leftToken], [rightToken]) >= anchorNgramThreshold)) {
        matchedIndex = index;
        break;
      }
    }
    if (matchedIndex === undefined) unmatchedLeft.push(leftToken);
    else remainingRight.delete(matchedIndex);
  }

  const unmatchedRight = [...remainingRight].map((index) => right[index]!);
  const sharedAnchorCount = left.length - unmatchedLeft.length;
  return sharedAnchorCount > 0 && unmatchedLeft.length === 1 && unmatchedRight.length === 1
    ? [unmatchedLeft[0]!, unmatchedRight[0]!]
    : null;
}

/** Mines only unambiguous cross-script residual equivalence from title variants within the same career track. */
export function mineRoleEquivalences(tracks: readonly RoleTrackTitles[]): RoleEquivalencePair[] {
  const support = new Map<string, { tokenA: string; tokenB: string; tracks: Set<number> }>();

  tracks.forEach((track, trackIndex) => {
    const variants = track.titleVariants.map((title) => [...searchTokens(title)]).filter((tokens) => tokens.length > 0);
    for (let leftIndex = 0; leftIndex < variants.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < variants.length; rightIndex += 1) {
        const left = variants[leftIndex]!;
        const right = variants[rightIndex]!;
        let residuals: readonly [string, string] | null = null;
        if (left.length === 1 && right.length === 1) residuals = [left[0]!, right[0]!];
        else residuals = anchoredResiduals(left, right);
        if (!residuals || !crossScript(residuals[0], residuals[1])) continue;

        const [tokenA, tokenB] = [...residuals].sort(compareStrings) as [string, string];
        if (tokenA === tokenB) continue;
        const key = `${tokenA}\0${tokenB}`;
        const entry = support.get(key) ?? { tokenA, tokenB, tracks: new Set<number>() };
        entry.tracks.add(trackIndex);
        support.set(key, entry);
      }
    }
  });

  return [...support.values()]
    .map((entry) => Object.freeze({ tokenA: entry.tokenA, tokenB: entry.tokenB, support: entry.tracks.size }))
    .sort((left, right) => compareStrings(left.tokenA, right.tokenA) || compareStrings(left.tokenB, right.tokenB));
}

function validatePair(pair: RoleEquivalencePair): readonly [string, string] {
  const tokenA = normalizeToken(pair.tokenA);
  const tokenB = normalizeToken(pair.tokenB);
  if (!tokenA || !tokenB) throw new TypeError('Invalid role equivalence pair: tokens must not be empty.');
  if (tokenA !== pair.tokenA || tokenB !== pair.tokenB) {
    throw new TypeError('Invalid role equivalence pair: tokens must already be NFKC-normalized and lowercase.');
  }
  if (tokenA === tokenB) throw new TypeError('Invalid role equivalence pair: tokens must be distinct.');
  if (!Number.isSafeInteger(pair.support) || pair.support < 1) {
    throw new RangeError(
      `Invalid role equivalence support: expected a positive safe integer, received ${pair.support}.`,
    );
  }
  return [tokenA, tokenB];
}

/** Builds deterministic transitive equivalence classes from approved persisted pair data. */
export function createRoleTokenResolver(pairs: readonly RoleEquivalencePair[]): RoleTokenResolver {
  const parent = new Map<string, string>();

  const find = (token: string): string => {
    const current = parent.get(token);
    if (current === undefined) {
      parent.set(token, token);
      return token;
    }
    if (current === token) return token;
    const root = find(current);
    parent.set(token, root);
    return root;
  };

  const union = (left: string, right: string): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    const [representative, other] = [leftRoot, rightRoot].sort(compareStrings);
    parent.set(other!, representative!);
  };

  for (const pair of pairs) {
    const [tokenA, tokenB] = validatePair(pair);
    union(tokenA, tokenB);
  }
  for (const token of parent.keys()) find(token);

  return (rawToken: string): string => {
    const token = normalizeToken(rawToken);
    return parent.get(token) ?? token;
  };
}
