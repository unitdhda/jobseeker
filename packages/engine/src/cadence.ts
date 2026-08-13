export interface CadencePolicy {
  readonly floorMinutes: number;
  readonly ceilingMinutes: number;
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(
      `Invalid cadence ${name}: expected a positive safe integer number of minutes, received ${value}.`,
    );
  }
}

/** Clamps the current cadence before adapting it, then enforces the relevant policy boundary. */
export function nextCadence(current: number, foundNovelty: boolean, policy: CadencePolicy): number {
  assertPositiveSafeInteger(current, 'current value');
  assertPositiveSafeInteger(policy.floorMinutes, 'floor');
  assertPositiveSafeInteger(policy.ceilingMinutes, 'ceiling');
  if (policy.floorMinutes > policy.ceilingMinutes) {
    throw new RangeError(
      `Invalid cadence policy: floor ${policy.floorMinutes} minutes must not exceed ceiling ${policy.ceilingMinutes} minutes.`,
    );
  }

  const clamped = Math.min(policy.ceilingMinutes, Math.max(policy.floorMinutes, current));
  return foundNovelty
    ? Math.max(policy.floorMinutes, Math.round(clamped / 2))
    : Math.min(policy.ceilingMinutes, Math.round(clamped * 1.5));
}
