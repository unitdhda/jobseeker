import assert from 'node:assert/strict';
import test from 'node:test';
import { parseUserId } from '@jobseeker/engine/contracts';
import type { SessionClaim } from '@jobseeker/store';
import { claimUserWorkflow, userWorkflowRenewMs, userWorkflowTtlMs, withUserWorkflow,
  type WorkflowSessionPorts } from '../src/telegram/workflow-lock.ts';

const userId = parseUserId('1');
function durablePorts() {
  let current: { state: Record<string, unknown>; token: string; expiresAt: Date } | null = null;
  let claims = 0; let renewals = 0; let releases = 0;
  const ports: WorkflowSessionPorts = {
    getTelegramSession: async <TResult>() => current?.state as TResult | undefined ?? null,
    claimTelegramSession: async <T extends Record<string, unknown>>(_user: unknown, _kind: string, state: T, ttl: number): Promise<SessionClaim<T>> => {
      claims += 1;
      if (current) return { claimed: false, expiresAt: current.expiresAt, state: current.state as T };
      const token = 'a'.repeat(64); current = { state: { ...state, token, _claimToken: token }, token, expiresAt: new Date(Date.now() + ttl) };
      return { claimed: true, expiresAt: current.expiresAt, state: current.state as T, token };
    },
    updateClaimedTelegramSession: async (_user, _kind, token, state, ttl) => {
      if (!current || current.token !== token) return false; renewals += 1;
      current = { state, token, expiresAt: new Date(Date.now() + ttl) }; return true;
    },
    releaseClaimedTelegramSession: async (_user, _kind, token) => {
      if (!current || current.token !== token) return false; releases += 1; current = null; return true;
    },
  };
  return { ports, counters: () => ({ claims, renewals, releases }), steal: () => { if (current) current.token = 'b'.repeat(64); } };
}

test('many repeated clicks start exactly one expensive workflow and every loser is explicitly non-queued', async () => {
  const fixture = durablePorts(); let starts = 0;
  const claims = await Promise.all(Array.from({ length: 25 }, () => claimUserWorkflow(fixture.ports, userId, 'tailored-cv')));
  for (const claim of claims) if (claim.claimed) starts += 1;
  assert.equal(starts, 1); assert.equal(claims.filter((claim) => !claim.claimed).length, 24);
  assert.ok(claims.filter((claim) => !claim.claimed).every((claim) => !claim.claimed && claim.current.kind === 'tailored-cv'));
  const winner = claims.find((claim) => claim.claimed); assert.ok(winner?.claimed); await winner!.lease.release();
  assert.deepEqual(fixture.counters(), { claims: 25, renewals: 0, releases: 1 });
});

test('workflow lease uses exact 30-minute TTL, token-owned renew/release, and idempotent local release', async () => {
  const fixture = durablePorts(); let observedTtl = 0;
  const wrapped: WorkflowSessionPorts = { ...fixture.ports,
    claimTelegramSession: async (user, kind, state, ttl) => { observedTtl = ttl; return fixture.ports.claimTelegramSession(user, kind, state, ttl); } };
  const claim = await claimUserWorkflow(wrapped, userId, 'cv-import', new Date('2025-01-01T00:00:00Z'));
  assert.equal(userWorkflowTtlMs, 30 * 60_000); assert.equal(userWorkflowRenewMs, 5 * 60_000); assert.equal(observedTtl, userWorkflowTtlMs);
  assert.equal(claim.claimed, true);
  if (claim.claimed) {
    assert.equal(claim.lease.state.startedAt, '2025-01-01T00:00:00.000Z'); assert.equal(await claim.lease.renew(), true);
    assert.equal(await claim.lease.release(), true); assert.equal(await claim.lease.release(), false);
  }
});

test('withUserWorkflow always releases and reports lease loss after renewal', async () => {
  const fixture = durablePorts(); let callback: (() => void) | undefined; let cleared = false;
  await assert.rejects(withUserWorkflow(fixture.ports, userId, 'profile-refresh', async () => {
    fixture.steal(); callback?.(); await new Promise((resolve) => setTimeout(resolve, 0)); return 'done';
  }, ((handler: () => void) => { callback = handler; return 1 as unknown as NodeJS.Timeout; }) as typeof setInterval,
  (() => { cleared = true; }) as typeof clearInterval), /lease was lost/u);
  assert.equal(cleared, true); assert.equal(fixture.counters().renewals, 0);
});
