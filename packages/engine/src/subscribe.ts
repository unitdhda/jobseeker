import { canonicalJsonStringify } from './canonical-json.ts';
import type { SourceKey, UserId } from './contracts.ts';
import { identityRoleResolver, type RoleTokenResolver } from './equivalence.ts';
import {
  tokenSimilarity,
  unitIdentityOf,
  type SearchUnitId,
  type UnitIdentity,
} from './identity.ts';

export interface NamedSearch {
  readonly name: string;
}

export interface CompiledUnit<TSearch = unknown> extends UnitIdentity {
  readonly query: TSearch;
}

export interface CompiledSubscription<TSearch = unknown> {
  readonly unitId: SearchUnitId;
  readonly userId: UserId;
  readonly searchName: string;
  readonly sourceSearch: TSearch;
}

export interface CompiledDemand<TSearch = unknown> {
  readonly units: readonly CompiledUnit<TSearch>[];
  readonly subscriptions: readonly CompiledSubscription<TSearch>[];
}

export interface DemandInput<TSearch extends NamedSearch = NamedSearch> {
  readonly userId: UserId;
  readonly platform: SourceKey;
  readonly searches: readonly TSearch[];
}

interface PreparedSearch<TSearch extends NamedSearch> {
  readonly userId: UserId;
  readonly sourceSearch: TSearch;
  readonly identity: UnitIdentity;
  readonly canonicalSearch: string;
  readonly wording: string;
}

interface SubscriptionChoice<TSearch extends NamedSearch> {
  readonly subscription: CompiledSubscription<TSearch>;
  readonly exact: boolean;
  readonly similarity: number;
  readonly wordingLength: number;
  readonly canonicalSearch: string;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function executableWording(search: unknown): string {
  if (typeof search !== 'object' || search === null || Array.isArray(search)) return '';

  const descriptors = Object.getOwnPropertyDescriptors(search);
  const parts: string[] = [];
  for (const field of ['text', 'query'] as const) {
    const descriptor = descriptors[field];
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string') continue;
    const text = descriptor.value.trim();
    if (text) parts.push(text);
  }
  return parts.join('\n');
}

function assertThreshold(threshold: number): void {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new RangeError(
      `Invalid demand similarity threshold: expected a finite number from 0 through 1, received ${threshold}.`,
    );
  }
}

function isBetterSubscription<TSearch extends NamedSearch>(
  incoming: SubscriptionChoice<TSearch>,
  current: SubscriptionChoice<TSearch>,
): boolean {
  if (incoming.exact !== current.exact) return incoming.exact;
  if (incoming.similarity !== current.similarity) return incoming.similarity > current.similarity;
  if (incoming.wordingLength !== current.wordingLength) return incoming.wordingLength < current.wordingLength;
  return compareStrings(incoming.canonicalSearch, current.canonicalSearch) < 0;
}

/**
 * Compiles private per-user demand into stable shared units and one subscription per unit/user pair. Exact identity
 * always wins; learned equivalence and lexical n-grams affect only one-time adoption of otherwise distinct demand.
 */
export function compileDemand<TSearch extends NamedSearch>(
  demands: readonly DemandInput<TSearch>[],
  threshold: number,
  existing: readonly CompiledUnit<TSearch>[] = [],
  resolver: RoleTokenResolver = identityRoleResolver,
): CompiledDemand<TSearch> {
  assertThreshold(threshold);

  const units = new Map<SearchUnitId, CompiledUnit<TSearch>>();
  for (const unit of [...existing].sort((left, right) => compareStrings(left.unitId, right.unitId))) {
    if (!units.has(unit.unitId)) units.set(unit.unitId, { ...unit });
  }

  const prepared: PreparedSearch<TSearch>[] = [];
  for (const demand of demands) {
    for (const sourceSearch of demand.searches) {
      const identity = unitIdentityOf(demand.platform, sourceSearch);
      prepared.push({
        userId: demand.userId,
        sourceSearch,
        identity,
        canonicalSearch: canonicalJsonStringify(sourceSearch, 'demand search'),
        wording: executableWording(sourceSearch),
      });
    }
  }
  prepared.sort((left, right) =>
    compareStrings(left.identity.platform, right.identity.platform)
    || compareStrings(left.userId, right.userId)
    || compareStrings(left.identity.unitId, right.identity.unitId)
    || compareStrings(left.canonicalSearch, right.canonicalSearch));

  const referencedUnitIds = new Set<SearchUnitId>();
  const subscriptions = new Map<string, SubscriptionChoice<TSearch>>();

  for (const item of prepared) {
    let unit = units.get(item.identity.unitId);
    let exact = unit !== undefined;
    let similarity = exact ? 1 : -1;

    if (!unit) {
      for (const candidate of units.values()) {
        if (candidate.platform !== item.identity.platform
          || candidate.filterSignature !== item.identity.filterSignature) continue;

        const candidateSimilarity = tokenSimilarity(
          candidate.canonicalTokens,
          item.identity.canonicalTokens,
          resolver,
        );
        if (candidateSimilarity < threshold) continue;
        if (candidateSimilarity > similarity
          || (candidateSimilarity === similarity
            && (!unit || compareStrings(candidate.unitId, unit.unitId) < 0))) {
          unit = candidate;
          similarity = candidateSimilarity;
        }
      }
    }

    if (!unit) {
      unit = { ...item.identity, query: item.sourceSearch };
      units.set(unit.unitId, unit);
      exact = true;
      similarity = 1;
    } else if (exact && item.wording.length > 0) {
      const currentWording = executableWording(unit.query);
      if (currentWording.length === 0 || item.wording.length < currentWording.length) {
        unit = { ...unit, query: item.sourceSearch };
        units.set(unit.unitId, unit);
      }
    }

    referencedUnitIds.add(unit.unitId);
    const subscription: CompiledSubscription<TSearch> = {
      unitId: unit.unitId,
      userId: item.userId,
      searchName: item.sourceSearch.name,
      sourceSearch: item.sourceSearch,
    };
    const choice: SubscriptionChoice<TSearch> = {
      subscription,
      exact,
      similarity,
      wordingLength: item.wording.length || Number.POSITIVE_INFINITY,
      canonicalSearch: item.canonicalSearch,
    };
    const key = `${unit.unitId}\0${item.userId}`;
    const current = subscriptions.get(key);
    if (!current || isBetterSubscription(choice, current)) subscriptions.set(key, choice);
  }

  return {
    units: [...referencedUnitIds]
      .sort(compareStrings)
      .map((unitId) => Object.freeze(units.get(unitId)!)),
    subscriptions: [...subscriptions.values()]
      .map((choice) => Object.freeze(choice.subscription))
      .sort((left, right) => compareStrings(left.unitId, right.unitId)
        || compareStrings(left.userId, right.userId)),
  };
}
