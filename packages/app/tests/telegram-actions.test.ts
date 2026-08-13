import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCvContentHash, parseUserId } from '@jobseeker/engine/contracts';
import type { ExtractedCvDocument } from '@jobseeker/cv/extract';
import type { SessionClaim } from '@jobseeker/store';
import type { CvParser } from '../src/cv.ts';
import type { JobWorkerClient } from '../src/worker-client.ts';
import { armCvUpload, confirmCvUpload, deliverApplicationArtifact, processCvUpload, rejectCvUpload,
  type ApplicationActionPorts, type CvActionPorts } from '../src/telegram/actions.ts';
import { createProgressIndicator } from '../src/telegram/indicators.ts';

const userId = parseUserId('1'); const hash = parseCvContentHash('a'.repeat(64));
const extraction: ExtractedCvDocument = { text: 'Verified CV evidence '.repeat(10), document: { version: 1, blocks: [] },
  sourceFormat: 'txt', mediaType: 'text/plain', parserName: 'test', parserVersion: '1' };
function sessionFixture() {
  const sessions = new Map<string, Record<string, unknown>>(); let current: { token: string; state: Record<string, unknown> } | null = null;
  const events: string[] = [];
  const common = {
    getTelegramSession: async <T>(_: unknown, kind: string) => (kind === 'user-workflow' ? current?.state : sessions.get(kind)) as T | undefined ?? null,
    setTelegramSession: async (_user: unknown, kind: string, state: unknown) => { sessions.set(kind, state as Record<string, unknown>); events.push(`set:${kind}`); },
    deleteTelegramSession: async (_user: unknown, kind: string) => { sessions.delete(kind); events.push(`delete:${kind}`); },
    claimTelegramSession: async <T extends Record<string, unknown>>(_user: unknown, _kind: string, state: T): Promise<SessionClaim<T>> => {
      if (current) return { claimed: false, expiresAt: new Date(Date.now() + 1000), state: current.state as T };
      const token = 'a'.repeat(64); current = { token, state: { ...state, token, _claimToken: token } };
      return { claimed: true, expiresAt: new Date(Date.now() + 1000), state: current.state as T, token };
    },
    updateClaimedTelegramSession: async (_user: unknown, _kind: string, token: string, state: Record<string, unknown>) => {
      if (!current || current.token !== token) return false; current.state = state; events.push(`handoff:${state.kind}`); return true; },
    releaseClaimedTelegramSession: async (_user: unknown, _kind: string, token: string) => {
      if (!current || current.token !== token) return false; current = null; events.push('release'); return true; },
  };
  return { common, sessions, events, current: () => current };
}
function cvFixture() {
  const base = sessionFixture(); let staged = false; let authoritative = false;
  const ports: CvActionPorts = { ...base.common,
    stageCvSource: async () => { staged = true; base.events.push('stage'); }, discardStagedCvSource: async () => { staged = false; base.events.push('discard'); },
    confirmStagedCvSource: async () => { if (!staged) return false; authoritative = true; staged = false; base.events.push('confirm'); return true; },
    getCvHash: async () => authoritative ? hash : null };
  return { ...base, ports, staged: () => staged, authoritative: () => authoritative };
}
function parser(): CvParser {
  return { activeCount: 0, pendingCount: 0, parse: async (filename) => ({ extraction, preview: { filename, sha256: hash,
    characterCount: extraction.text.length, blockCount: 0, excerpt: extraction.text.slice(0, 700), warnings: [] } }) };
}

test('CV upload arms once, validates before download, stages preview, and retains workflow for confirmation', async () => {
  const fixture = cvFixture(); assert.equal(await armCvUpload(fixture.ports, userId), true); assert.equal(await armCvUpload(fixture.ports, userId), false);
  let downloads = 0;
  const invalid = await processCvUpload({ ports: fixture.ports, parser: parser(), userId,
    document: { filename: 'cv.exe', mediaType: 'application/x-msdownload', declaredSize: 100, download: async () => { downloads += 1; return new Uint8Array(100); } } });
  assert.equal(invalid.kind, 'invalid'); assert.equal(downloads, 0);
  const result = await processCvUpload({ ports: fixture.ports, parser: parser(), userId,
    document: { filename: 'cv.txt', mediaType: 'text/plain', declaredSize: 100, download: async () => { downloads += 1; return new Uint8Array(100); } } });
  assert.equal(result.kind, 'preview'); assert.equal(downloads, 1); assert.equal(fixture.staged(), true); assert.ok(fixture.current());
  assert.equal(fixture.sessions.has('cv-upload'), false); assert.equal(fixture.sessions.has('cv-confirm'), true);
});

test('confirm consumes staged CV, hands same token to profile refresh worker, then releases', async () => {
  const fixture = cvFixture(); await armCvUpload(fixture.ports, userId);
  await processCvUpload({ ports: fixture.ports, parser: parser(), userId,
    document: { filename: 'cv.txt', mediaType: 'text/plain', declaredSize: 10, download: async () => new Uint8Array(10) } });
  const requests: unknown[] = [];
  const worker: Pick<JobWorkerClient, 'request'> = { request: async (payload) => { requests.push(payload); return { type: 'refresh-user', cvHash: hash,
    generatedPlatforms: [], failedPlatforms: {} }; } };
  assert.equal(await confirmCvUpload({ ports: fixture.ports, worker, userId }), true);
  assert.equal(fixture.authoritative(), true); assert.deepEqual(requests, [{ type: 'refresh-user', userId, cvHash: hash }]);
  assert.ok(fixture.events.indexOf('confirm') < fixture.events.indexOf('handoff:profile-refresh'));
  assert.equal(fixture.events.at(-1), 'release'); assert.equal(fixture.sessions.has('cv-confirm'), false);
});

test('reject discards only staged CV, releases lease, and rearms upload', async () => {
  const fixture = cvFixture(); await armCvUpload(fixture.ports, userId);
  await processCvUpload({ ports: fixture.ports, parser: parser(), userId,
    document: { filename: 'cv.txt', mediaType: 'text/plain', declaredSize: 10, download: async () => new Uint8Array(10) } });
  assert.equal(await rejectCvUpload(fixture.ports, userId), true); assert.equal(fixture.staged(), false);
  assert.equal(fixture.authoritative(), false); assert.equal(fixture.sessions.has('cv-upload'), true); assert.equal(fixture.current(), null);
});

function applicationFixture() {
  const base = sessionFixture(); const saved: string[] = []; let applied = 0;
  const ports: ApplicationActionPorts = { ...base.common,
    saveDeliveredArtifact: async (_user, _id, artifact, value) => { saved.push(`${artifact}:${value.fileId ?? value.text}`); return true; },
    markApplicationDelivered: async () => { applied += 1; return true; } };
  return { ...base, ports, saved, applied: () => applied };
}

test('application actions resend cache without persistence and persist generated artifacts only after send', async () => {
  const cached = applicationFixture(); const sends: string[] = [];
  const cachedWorker: Pick<JobWorkerClient, 'request'> = { request: async () => ({ type: 'tailor-application', artifact: 'cv', kind: 'cached', cvHash: hash, fileId: 'file-1' }) };
  assert.equal(await deliverApplicationArtifact({ ports: cached.ports, worker: cachedWorker, userId, vacancyId: 7, artifact: 'cv',
    transport: { sendDocument: async () => ({ fileId: 'unused' }), sendFileId: async (_user, id) => { sends.push(id); }, sendText: async () => undefined } }), 'cached');
  assert.deepEqual(sends, ['file-1']); assert.deepEqual(cached.saved, []); assert.equal(cached.applied(), 0);

  const generated = applicationFixture();
  const worker: Pick<JobWorkerClient, 'request'> = { request: async () => ({ type: 'tailor-application', artifact: 'letter', kind: 'generated', cvHash: hash, text: 'Generated letter' }) };
  assert.equal(await deliverApplicationArtifact({ ports: generated.ports, worker, userId, vacancyId: 7, artifact: 'letter',
    transport: { sendDocument: async () => ({ fileId: 'x' }), sendFileId: async () => undefined, sendText: async () => undefined } }), 'generated');
  assert.deepEqual(generated.saved, ['letter:Generated letter']); assert.equal(generated.applied(), 1);
});

test('failed Telegram send persists nothing and concurrent repeated application click never reaches worker', async () => {
  const failed = applicationFixture(); let requests = 0;
  const worker: Pick<JobWorkerClient, 'request'> = { request: async () => { requests += 1; return { type: 'tailor-application', artifact: 'cv', kind: 'generated', cvHash: hash,
    pdf: new Uint8Array([1]) }; } };
  await assert.rejects(deliverApplicationArtifact({ ports: failed.ports, worker, userId, vacancyId: 7, artifact: 'cv',
    transport: { sendDocument: async () => { throw new Error('send'); }, sendFileId: async () => undefined, sendText: async () => undefined } }), /send/u);
  assert.deepEqual(failed.saved, []); assert.equal(failed.applied(), 0);

  const busy = applicationFixture(); const claim = await busy.ports.claimTelegramSession(userId, 'user-workflow',
    { kind: 'cover-letter', startedAt: new Date().toISOString() }, 1000);
  assert.equal(claim.claimed, true);
  assert.equal(await deliverApplicationArtifact({ ports: busy.ports, worker, userId, vacancyId: 7, artifact: 'letter',
    transport: { sendDocument: async () => ({ fileId: 'x' }), sendFileId: async () => undefined, sendText: async () => undefined } }), 'busy');
  assert.equal(requests, 1);
});

test('indicator suppresses duplicate edits and treats edit/delete failures as best effort', async () => {
  const events: string[] = [];
  const indicator = await createProgressIndicator({ send: async (text) => { events.push(`send:${text}`); return { messageId: 1 }; },
    edit: async (_id, text) => { events.push(`edit:${text}`); if (text === 'fail') throw new Error('edit'); },
    delete: async () => { events.push('delete'); throw new Error('delete'); } }, 'start');
  assert.equal(await indicator.update('start'), false); assert.equal(await indicator.update('next'), true); assert.equal(await indicator.update('fail'), false);
  await indicator.close(); await indicator.close(); assert.deepEqual(events, ['send:start', 'edit:next', 'edit:fail', 'delete']);
});
