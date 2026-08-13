import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { bundledEntryPath, packageAssetPath, packageRootPath } from '../src/deployment-paths.ts';

test('deployment paths resolve entries/assets from source, flat dist, and shared chunks', () => {
  const source = pathToFileURL('/opt/jobseeker/src/service.ts').href;
  assert.equal(bundledEntryPath(source, 'worker.js'), '/opt/jobseeker/src/worker.js');
  assert.equal(packageRootPath(source), '/opt/jobseeker');
  assert.equal(packageAssetPath(source, 'fonts'), '/opt/jobseeker/fonts');

  const flat = pathToFileURL('/opt/jobseeker/dist/cli.js').href;
  assert.equal(bundledEntryPath(flat, 'worker.js'), '/opt/jobseeker/dist/worker.js');
  assert.equal(packageRootPath(flat), '/opt/jobseeker');

  const chunk = pathToFileURL('/opt/jobseeker/dist/chunks/service-a1.js').href;
  assert.equal(bundledEntryPath(chunk, 'worker.js'), '/opt/jobseeker/dist/worker.js');
  assert.equal(packageRootPath(chunk), '/opt/jobseeker');
  assert.equal(packageAssetPath(chunk, 'schema.sql'), '/opt/jobseeker/schema.sql');
});
