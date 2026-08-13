import type { UserId } from '@jobseeker/engine/contracts';
import type { SessionClaim } from '@jobseeker/store';

export type UserWorkflowKind = 'cv-import' | 'profile-refresh' | 'tailored-cv' | 'cover-letter';
export interface UserWorkflowState {
  readonly token: string;
  readonly kind: UserWorkflowKind;
  readonly startedAt: string;
}
export interface WorkflowSessionPorts {
  getTelegramSession<TResult>(userId: UserId, kind: string): Promise<TResult | null>;
  claimTelegramSession<TResult extends Record<string, unknown>>(userId: UserId, kind: string, state: TResult, ttlMs: number): Promise<SessionClaim<TResult>>;
  updateClaimedTelegramSession(userId: UserId, kind: string, token: string, state: Record<string, unknown>, ttlMs: number): Promise<boolean>;
  releaseClaimedTelegramSession(userId: UserId, kind: string, token: string): Promise<boolean>;
}
export interface UserWorkflowLease {
  readonly userId: UserId;
  readonly state: UserWorkflowState;
  readonly expiresAt: Date;
  renew(): Promise<boolean>;
  handoff(kind: UserWorkflowKind): Promise<boolean>;
  release(): Promise<boolean>;
}
export type UserWorkflowClaim =
  | { readonly claimed: true; readonly lease: UserWorkflowLease }
  | { readonly claimed: false; readonly current: Omit<UserWorkflowState, 'token'>; readonly expiresAt: Date };

export const userWorkflowTtlMs = 30 * 60_000;
export const userWorkflowRenewMs = 5 * 60_000;
const sessionKind = 'user-workflow';
function validKind(value: unknown): UserWorkflowKind {
  if (!['cv-import', 'profile-refresh', 'tailored-cv', 'cover-letter'].includes(String(value))) {
    throw new TypeError('Invalid stored user workflow kind.');
  }
  return value as UserWorkflowKind;
}
function validStartedAt(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(new Date(value).getTime())) throw new TypeError('Invalid stored workflow start time.');
  return value;
}

export async function claimUserWorkflow(ports: WorkflowSessionPorts, userId: UserId,
  kind: UserWorkflowKind, now: Date = new Date()): Promise<UserWorkflowClaim> {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('Invalid workflow start time.');
  validKind(kind);
  const state = { kind, startedAt: now.toISOString() };
  const claim = await ports.claimTelegramSession(userId, sessionKind, state, userWorkflowTtlMs);
  if (!claim.claimed) {
    const current = claim.state as Record<string, unknown>;
    return Object.freeze({ claimed: false, current: Object.freeze({ kind: validKind(current.kind),
      startedAt: validStartedAt(current.startedAt) }), expiresAt: new Date(claim.expiresAt) });
  }
  const token = claim.token ?? (claim.state as Record<string, unknown>).token;
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/u.test(token)) throw new TypeError('Workflow claim returned no valid token.');
  let activeKind = kind; let released = false;
  const workflowState = Object.freeze({ token, kind, startedAt: state.startedAt });
  const lease: UserWorkflowLease = Object.freeze({
    userId, state: workflowState, expiresAt: new Date(claim.expiresAt),
    renew: async () => released ? false : ports.updateClaimedTelegramSession(userId, sessionKind, token,
      { kind: activeKind, startedAt: state.startedAt, token }, userWorkflowTtlMs),
    handoff: async (nextKind: UserWorkflowKind) => {
      validKind(nextKind); if (released) return false;
      const updated = await ports.updateClaimedTelegramSession(userId, sessionKind, token,
        { kind: nextKind, startedAt: state.startedAt, token }, userWorkflowTtlMs);
      if (updated) activeKind = nextKind;
      return updated;
    },
    release: async () => { if (released) return false; released = true;
      return ports.releaseClaimedTelegramSession(userId, sessionKind, token); },
  });
  return Object.freeze({ claimed: true, lease });
}

export async function resumeUserWorkflow(ports: WorkflowSessionPorts, userId: UserId, token: string,
  expectedKind: UserWorkflowKind): Promise<UserWorkflowLease | null> {
  if (!/^[0-9a-f]{64}$/u.test(token)) throw new TypeError('Invalid workflow resume token.');
  const stored = await ports.getTelegramSession<Record<string, unknown>>(userId, sessionKind);
  if (!stored || stored.token !== token || validKind(stored.kind) !== expectedKind) return null;
  const startedAt = validStartedAt(stored.startedAt); let released = false; let activeKind = expectedKind;
  return Object.freeze({ userId, state: Object.freeze({ token, kind: expectedKind, startedAt }),
    expiresAt: new Date(Date.now() + userWorkflowTtlMs),
    renew: async () => released ? false : ports.updateClaimedTelegramSession(userId, sessionKind, token,
      { kind: activeKind, startedAt, token }, userWorkflowTtlMs),
    handoff: async (kind: UserWorkflowKind) => { validKind(kind); if (released) return false;
      const updated = await ports.updateClaimedTelegramSession(userId, sessionKind, token, { kind, startedAt, token }, userWorkflowTtlMs);
      if (updated) activeKind = kind; return updated; },
    release: async () => { if (released) return false; released = true;
      return ports.releaseClaimedTelegramSession(userId, sessionKind, token); },
  });
}

export async function withUserWorkflow<TResult>(ports: WorkflowSessionPorts, userId: UserId, kind: UserWorkflowKind,
  operation: (lease: UserWorkflowLease) => Promise<TResult>, setIntervalFn: typeof setInterval = setInterval,
  clearIntervalFn: typeof clearInterval = clearInterval): Promise<TResult | UserWorkflowClaim> {
  const claim = await claimUserWorkflow(ports, userId, kind);
  if (!claim.claimed) return claim;
  let renewalFailure: unknown;
  const timer = setIntervalFn(() => { void claim.lease.renew().then((owned) => {
    if (!owned) renewalFailure = new Error('User workflow lease was lost.');
  }, (error) => { renewalFailure = error; }); }, userWorkflowRenewMs);
  try {
    const result = await operation(claim.lease);
    if (renewalFailure) throw renewalFailure;
    return result;
  } finally {
    clearIntervalFn(timer);
    await claim.lease.release().catch(() => false);
  }
}
