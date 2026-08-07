import { tokenSimilarity, unitIdentityOf, type UnitIdentity } from './identity.ts';

/** A unit as the compiler sees it: identity plus the representative search object that adapters will execute. */
export interface CompiledUnit extends UnitIdentity {
  query: unknown;
}
export interface CompiledSubscription {
  unitId: string;
  userId: string;
  /** The user's own name for the search, so prefiltering and messages keep speaking their language. */
  searchName: string;
  sourceSearch: unknown;
}
export interface CompiledDemand {
  units: CompiledUnit[];
  subscriptions: CompiledSubscription[];
}

export interface DemandInput {
  userId: string;
  platform: string;
  searches: readonly unknown[];
}

/**
 * Compiles raw per-user searches into units and subscriptions. Exact identity wins outright; otherwise a search may
 * be adopted by an existing unit with the identical filter signature and token similarity at or above the threshold.
 * Adoption happens once, here, against the population that exists at compile time — units never re-cluster later,
 * which is what the per-cycle Jaccard grouping could never promise.
 *
 * The shortest query text is kept as the unit's representative, it being the broadest formulation of the demand.
 */
export function compileDemand(demands: readonly DemandInput[], similarityThreshold: number,
  existing: readonly CompiledUnit[] = [],
  resolve: (token: string) => string = (token) => token): CompiledDemand {
  const units = new Map<string, CompiledUnit>(existing.map((unit) => [unit.unitId, unit]));
  const minted: CompiledUnit[] = [];
  const subscriptions = new Map<string, CompiledSubscription>();

  const ordered = [...demands].sort((left, right) =>
    left.platform.localeCompare(right.platform) || left.userId.localeCompare(right.userId));
  for (const demand of ordered) {
    for (const search of demand.searches) {
      const identity = unitIdentityOf(demand.platform, search);
      const record = (search ?? {}) as Record<string, string>;
      const searchName = typeof record.name === 'string' ? record.name : '';
      let unit = units.get(identity.unitId);
      if (!unit) {
        unit = [...units.values()].find((candidate) => candidate.platform === identity.platform
          && candidate.filterSignature === identity.filterSignature
          && tokenSimilarity(candidate.canonicalTokens, identity.canonicalTokens, resolve) >= similarityThreshold);
      }
      if (!unit) {
        unit = { ...identity, query: search };
        units.set(unit.unitId, unit);
        minted.push(unit);
      } else if (queryText(search).length > 0
        && (queryText(unit.query).length === 0 || queryText(search).length < queryText(unit.query).length)
        && unit.unitId === identity.unitId) {
        unit.query = search;
      }
      const key = `${unit.unitId}:${demand.userId}`;
      if (!subscriptions.has(key)) {
        subscriptions.set(key, { unitId: unit.unitId, userId: demand.userId, searchName, sourceSearch: search });
      }
    }
  }
  return { units: minted, subscriptions: [...subscriptions.values()] };
}

function queryText(search: unknown): string {
  const record = (search ?? {}) as Record<string, unknown>;
  return typeof record.text === 'string' ? record.text : typeof record.query === 'string' ? record.query : '';
}
