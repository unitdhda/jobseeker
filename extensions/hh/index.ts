import type { JobseekerExtensionApi } from '../extension-api.ts';
import { hhSource } from './hh.ts';
import { persistHhBrowserState, restoreHhBrowserState } from './state.ts';
import { initToolkit } from './toolkit.ts';

function positiveInteger(value: string | undefined, fallback: number, name: string, maximum: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new RangeError(`Invalid HH ${name}.`);
  return parsed;
}
function boolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  if (value === '1' || value.toLowerCase() === 'true') return true;
  if (value === '0' || value.toLowerCase() === 'false') return false;
  throw new TypeError('Invalid HH boolean setting.');
}

export default function register(api: JobseekerExtensionApi): void {
  initToolkit(api);
  const browserDataPath = api.env.HH_BROWSER_DATA_PATH?.trim() || '/tmp/jobseeker-hh-browser';
  const provider = hhSource({
    areaId: api.env.HH_AREA_ID?.trim() || '1',
    maxPages: positiveInteger(api.env.HH_MAX_PAGES, 1, 'page limit', 100),
    browserDataPath,
    operationTimeoutSeconds: positiveInteger(api.env.HH_OPERATION_TIMEOUT_SECONDS, 180, 'operation timeout', 900),
    playwrightHeadless: boolean(api.env.HH_HEADLESS, true),
    ...(api.env.HH_CHROMIUM_PATH?.trim() ? { playwrightChromiumPath: api.env.HH_CHROMIUM_PATH.trim() } : {}),
    timezone: api.env.HH_TIMEZONE?.trim() || 'Europe/Moscow',
    browserEnvironment: {
      lang: api.env.HH_LANG?.trim() || 'C.UTF-8',
      path: api.env.PATH?.trim() || '/usr/local/bin:/usr/bin:/bin',
      tmpdir: api.env.TMPDIR?.trim() || '/tmp',
    },
  });
  api.registerSourceProvider(provider);
  api.onStartup(async () => {
    if (await restoreHhBrowserState(api.state, browserDataPath)) api.log('restored encrypted browser state');
  });
  api.onShutdown(async () => {
    if (await persistHhBrowserState(api.state, browserDataPath)) api.log('persisted encrypted browser state');
  });
}
