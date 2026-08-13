export type MatchState =
  | 'matched'
  | 'queued'
  | 'scored'
  | 'alerted'
  | 'digested'
  | 'skipped'
  | 'applying'
  | 'applied'
  | 'expired';

const allowedTransitions: Readonly<Record<MatchState, ReadonlySet<MatchState>>> = {
  matched: new Set(['queued', 'expired']),
  queued: new Set(['scored', 'matched', 'expired']),
  scored: new Set(['alerted', 'digested', 'skipped', 'expired']),
  alerted: new Set(['applying', 'skipped']),
  digested: new Set(['applying', 'skipped']),
  skipped: new Set(['applying']),
  applying: new Set(['applied', 'alerted', 'digested', 'skipped']),
  applied: new Set(),
  expired: new Set(),
};

export const deliveredStates = Object.freeze([
  'alerted',
  'digested',
  'skipped',
  'applying',
  'applied',
] as const satisfies readonly MatchState[]);

export class MatchTransitionError extends Error {
  readonly from: MatchState;
  readonly to: MatchState;
  readonly allowed: readonly MatchState[];

  constructor(from: MatchState, to: MatchState, allowed: readonly MatchState[]) {
    const explanation = allowed.length > 0
      ? `allowed destinations are ${allowed.join(', ')}.`
      : `${from} is terminal and permits no outgoing transitions.`;
    super(`Invalid match transition from ${from} to ${to}: ${explanation}`);
    this.name = 'MatchTransitionError';
    this.from = from;
    this.to = to;
    this.allowed = Object.freeze([...allowed]);
  }
}

export function canTransition(from: MatchState, to: MatchState): boolean {
  return allowedTransitions[from].has(to);
}

export function assertTransition(from: MatchState, to: MatchState): void {
  if (canTransition(from, to)) return;
  throw new MatchTransitionError(from, to, [...allowedTransitions[from]]);
}
