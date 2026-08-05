/**
 * The life of a match, as the schema's single source of truth. Store repositories enforce these transitions, so an
 * illegal move — re-alerting something delivered, un-scoring a score — fails loudly instead of corrupting memory.
 */
export type MatchState =
  | 'matched'   // above the lexical floor, waiting for the scoring queue
  | 'queued'    // claimed by a scoring batch
  | 'scored'    // has an llm_score, waiting for delivery routing
  | 'alerted' | 'digested' | 'skipped'  // delivered (or declined by the user); terminal for discovery
  | 'applying' | 'applied'              // application flow after delivery
  | 'expired';                          // aged out before delivery

const transitions: Record<MatchState, readonly MatchState[]> = {
  matched: ['queued', 'expired'],
  queued: ['scored', 'matched', 'expired'],   // back to matched when a scoring batch fails
  scored: ['alerted', 'digested', 'skipped', 'expired'],
  alerted: ['applying', 'skipped'],
  digested: ['applying', 'skipped'],
  skipped: ['applying'],                       // a user may return to a listing they skipped
  applying: ['applied', 'alerted', 'digested', 'skipped'], // failure returns to the delivered state
  applied: [],
  expired: [],
};

export function canTransition(from: MatchState, to: MatchState): boolean {
  return transitions[from]?.includes(to) ?? false;
}

export function assertTransition(from: MatchState, to: MatchState): void {
  if (!canTransition(from, to)) throw new Error(`Illegal match transition ${from} -> ${to}.`);
}

/** States that mean the user has already seen this vacancy; nothing in these states may ever be delivered again. */
export const deliveredStates: readonly MatchState[] = ['alerted', 'digested', 'skipped', 'applying', 'applied'];
