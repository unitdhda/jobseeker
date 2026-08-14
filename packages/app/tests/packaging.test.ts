import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const repository = resolve(import.meta.dirname, '../../..');
const json = async (path: string) => JSON.parse(await readFile(resolve(repository, path), 'utf8')) as Record<string, any>;
const text = (path: string) => readFile(resolve(repository, path), 'utf8');

test('published app and reference deployment pin version 0.2.2 consistently', async () => {
  const app = await json('packages/app/package.json'); const deployment = await json('docker/vps/package.json');
  const compose = await text('docker/vps/compose.yaml');
  assert.equal(app.version, '0.2.2'); assert.equal(deployment.version, app.version);
  assert.equal(deployment.dependencies['@unitdhda/jobseeker'], app.version);
  assert.match(compose, new RegExp(`image: unitdhda/jobseeker:${app.version.replaceAll('.', '\\.')}`, 'u'));
});

test('publish set contains launcher, dist declaration, schema, docs, and licensed Google fonts', async () => {
  const app = await json('packages/app/package.json');
  assert.deepEqual(app.files, ['bin', 'dist', 'fonts', 'schema.sql', 'LICENSE', 'README.md']);
  for (const path of ['packages/app/bin/jobseeker.mjs', 'packages/app/schema.sql', 'packages/app/LICENSE', 'packages/app/README.md']) {
    await access(resolve(repository, path));
  }
  const fonts = await readdir(resolve(repository, 'packages/app/fonts'));
  for (const expected of ['Spectral-Regular.ttf', 'Spectral-Bold.ttf', 'Spectral-Italic.ttf', 'Spectral-BoldItalic.ttf',
    'JetBrainsMono[wght].ttf', 'JetBrainsMono-Italic[wght].ttf', 'OFL-Spectral.txt', 'OFL-JetBrainsMono.txt']) assert.ok(fonts.includes(expected));
  assert.equal(fonts.some((name) => name.startsWith('LiberationSans')), false);
});

test('Vite uses exact SSR entries, bundles workspaces, externalizes dependencies, and emits PDF worker', async () => {
  const vite = await text('packages/app/vite.config.ts');
  for (const entry of ["server: resolve(root, 'src/web.ts')", "cli: resolve(root, 'src/cli.ts')", "worker: resolve(root, 'src/worker.ts')",
    "'cv-worker': resolve(root, 'src/cv-worker.ts')", "'refresh-profiles': resolve(root, 'src/profile-refresh.ts')"]) assert.match(vite, new RegExp(entry.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assert.match(vite, /ssr: true/u); assert.match(vite, /ssrEmitAssets: true/u);
  assert.match(vite, /pdfjs-dist\/build\/pdf\.worker\.min\.mjs/u);
  assert.doesNotMatch(vite, /@jobseeker/u);
  const profile = await text('packages/app/src/profile-refresh.ts');
  assert.match(profile, /executableName === 'refresh-profiles\.js'/u);
});

test('app declares every bundled workspace runtime external at the exact workspace version', async () => {
  const app = await json('packages/app/package.json');
  for (const workspace of ['packages/engine/package.json', 'packages/cv/package.json', 'packages/sources/package.json', 'packages/store/package.json']) {
    const manifest = await json(workspace);
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      if (name.startsWith('@jobseeker/')) continue;
      assert.equal(app.dependencies[name], version, `${name} from ${workspace}`);
    }
  }
});

test('reference container installs the published package and applies required hardening', async () => {
  const dockerfile = await text('docker/vps/Dockerfile'); const compose = await text('docker/vps/compose.yaml');
  await access(resolve(repository, 'docker/vps/extensions/.gitkeep'));
  assert.match(dockerfile, /^FROM node:24-slim$/mu); assert.match(dockerfile, /npm install --omit=dev/u);
  assert.doesNotMatch(dockerfile, /(?:bun|vite|tsc|COPY packages|COPY src)/u); assert.match(dockerfile, /USER node/u);
  assert.match(dockerfile, /PLAYWRIGHT_BROWSERS_PATH=\/ms-playwright/u);
  assert.match(dockerfile, /HEALTHCHECK/u); assert.match(dockerfile, /CMD \["start"\]/u);
  for (const fragment of ['TELEGRAM_MODE: polling', 'RUN_JOBS: "true"', 'restart: unless-stopped', 'init: true', 'read_only: true',
    'cap_drop:', '- ALL', 'no-new-privileges:true', 'seccomp=../seccomp-chromium.json', 'pids_limit:', 'mem_limit:', 'cpus:',
    '/tmp:rw,noexec,nosuid,nodev,size=256m', 'jobseeker-data:/app/data', 'AI_AUTH_FILE: /app/data/auth.json',
    '127.0.0.1:3000:3000', 'driver: bridge']) assert.ok(compose.includes(fragment), fragment);
  assert.doesNotMatch(compose, /\/app\/auth/u);
  assert.doesNotMatch(compose, /docker\.sock|network_mode:\s*host|0\.0\.0\.0:3000/u);
});

test('manual release runs locked install, gates, external Node smoke, and provenance publish', async () => {
  const release = await text('.github/workflows/release.yml');
  for (const fragment of ['workflow_dispatch:', 'bun-version: 1.3.14', 'node-version: 24.14.0', 'bun install --frozen-lockfile',
    'bun run typecheck', 'bun run test', 'bun run build', 'npm pack --json', 'npx --no-install jobseeker help',
    'npm publish --provenance --access public', 'id-token: write']) assert.ok(release.includes(fragment), fragment);
});
