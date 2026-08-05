/**
 * A unit's polling rhythm follows its yield. Novelty halves the interval toward the floor — a source that just
 * produced something new is likely to produce more; emptiness backs off toward the ceiling, so a search that has
 * gone quiet stops spending the politeness budget other units could use.
 */
export interface CadencePolicy {
  floorMinutes: number;
  ceilingMinutes: number;
}

export function nextCadence(currentMinutes: number, foundNovelty: boolean, policy: CadencePolicy): number {
  const bounded = Math.min(policy.ceilingMinutes, Math.max(policy.floorMinutes, currentMinutes));
  return foundNovelty
    ? Math.max(policy.floorMinutes, Math.round(bounded / 2))
    : Math.min(policy.ceilingMinutes, Math.round(bounded * 1.5));
}
