/**
 * hh.ru vacancy source as a deployment extension: hh needs a persistent Chromium profile and the playwright
 * dependency, which the published application deliberately does not carry. Configuration comes from the same HH_*
 * and PLAYWRIGHT_* variables the built-in provider used to read.
 */
import { resolve } from 'node:path';
import type { JobseekerExtensionApi } from '../extension-api.ts';
import { hhSource } from './hh.ts';
import { persistHhBrowserState, restoreHhBrowserState } from './state.ts';
import { initToolkit } from './toolkit.ts';

function integer(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export default function register(api: JobseekerExtensionApi): void {
  initToolkit(api);
  const env = api.env;
  const browserDataPath = resolve(env.HH_BROWSER_DATA_PATH ?? './data/hh-browser');
  api.registerSourceProvider(hhSource({
    areaId: env.HH_AREA_ID ?? '1',
    maxPages: integer(env.HH_MAX_PAGES, 1),
    browserDataPath,
    operationTimeoutSeconds: integer(env.HH_OPERATION_TIMEOUT_SECONDS, 180),
    playwrightHeadless: env.PLAYWRIGHT_HEADLESS !== 'false',
    playwrightChromiumPath: env.PLAYWRIGHT_CHROMIUM_PATH,
    timezone: env.TIMEZONE ?? 'Europe/Moscow',
    browserEnvironment: {
      lang: env.LANG ?? 'C.UTF-8',
      path: env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      tmpdir: env.TMPDIR ?? '/tmp',
    },
  }));
  api.onStartup(async () => {
    const restored = await restoreHhBrowserState(api.state, browserDataPath);
    if (restored) api.log('HH browser state restored from the encrypted store.');
  });
  api.onShutdown(async () => {
    await persistHhBrowserState(api.state, browserDataPath);
  });
}
