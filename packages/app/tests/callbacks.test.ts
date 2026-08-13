import assert from 'node:assert/strict';
import test from 'node:test';
import { parseUserId } from '@jobseeker/engine/contracts';
import type { JobWorkerClient } from '../src/worker-client.ts';
import { parseTelegramCallback, routeTelegramCallback, type CallbackPorts } from '../src/telegram/callbacks.ts';
import type { ApplicationActionPorts, CvActionPorts } from '../src/telegram/actions.ts';

const userId = parseUserId('1');
test('callback parser accepts only strict application-controlled payloads', () => {
  assert.deepEqual(parseTelegramCallback('cv:confirm'), { type: 'cv-confirm' });
  assert.deepEqual(parseTelegramCallback('digest:2'), { type: 'digest', page: 2 });
  assert.deepEqual(parseTelegramCallback('apply:letter:42'), { type: 'apply', artifact: 'letter', vacancyId: 42 });
  assert.deepEqual(parseTelegramCallback('skip:7'), { type: 'skip', vacancyId: 7 });
  for (const value of ['digest:-1', 'apply:pdf:1', 'apply:cv:0', 'skip:1 OR 1=1', 'source:https://evil.test']) {
    assert.throws(() => parseTelegramCallback(value), /Invalid/u);
  }
});

function fixture(approved = true) {
  const events: string[] = [];
  const session = { getTelegramSession: async () => null, claimTelegramSession: async () => ({ claimed: false, expiresAt: new Date(),
    state: { kind: 'tailored-cv', startedAt: new Date().toISOString() } }), updateClaimedTelegramSession: async () => false,
    releaseClaimedTelegramSession: async () => false };
  const ports: CallbackPorts = {
    store: { isApprovedUser: async () => approved, skipVacancy: async (_user, id) => { events.push(`skip:${id}`); return true; },
      deleteUserData: async () => { events.push('delete'); } },
    cvActions: { ...session, setTelegramSession: async () => undefined, deleteTelegramSession: async () => undefined,
      stageCvSource: async () => undefined, discardStagedCvSource: async () => undefined,
      confirmStagedCvSource: async () => false, getCvHash: async () => null } as CvActionPorts,
    applicationActions: { ...session, saveDeliveredArtifact: async () => true, markApplicationDelivered: async () => true } as ApplicationActionPorts,
    worker: { request: async () => { throw new Error('unused'); } } as Pick<JobWorkerClient, 'request'>,
    applicationTransport: { sendDocument: async () => ({ fileId: 'x' }), sendFileId: async () => undefined, sendText: async () => undefined },
    delivery: { isApprovedUser: async () => approved, unsentHighScoreVacancies: async () => [], markAlerted: async () => true,
      digestVacancies: async () => [], addressableDigestPage: async () => ({ vacancies: [], allApplyIds: [], total: 0 }),
      replaceDigestSnapshot: async () => undefined }, digestMinScore: 50, alertScore: 80,
  };
  return { ports, events };
}

test('callbacks recheck approved access before parsing or mutation', async () => {
  const denied = fixture(false); const answers: string[] = [];
  assert.equal(await routeTelegramCallback({ data: 'skip:7', senderId: 1, locale: 'en', ports: denied.ports,
    transport: { answer: async (text) => { answers.push(text ?? ''); }, edit: async () => undefined } }), 'denied');
  assert.deepEqual(denied.events, []); assert.deepEqual(answers, ['Access denied.']);
});

test('skip, privacy deletion, and digest callbacks invoke only their intended typed port', async () => {
  const value = fixture(); const edits: string[] = [];
  const transport = { answer: async () => undefined, edit: async (html: string) => { edits.push(html); } };
  assert.equal(await routeTelegramCallback({ data: 'skip:7', senderId: 1, locale: 'en', ports: value.ports, transport }), 'handled');
  assert.equal(await routeTelegramCallback({ data: 'privacy:delete', senderId: 1, locale: 'en', ports: value.ports, transport }), 'handled');
  assert.equal(await routeTelegramCallback({ data: 'digest:0', senderId: 1, locale: 'en', ports: value.ports, transport }), 'handled');
  assert.deepEqual(value.events, ['skip:7', 'delete']); assert.deepEqual(edits, ['There are no matching vacancies for the digest yet.']);
  assert.equal(userId, '1');
});
