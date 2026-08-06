/** Trusted provider factories are configured before the store so URL validation has no source/store import cycle. */
import { createSourceUrlPolicy } from '@jobseeker/sources';
import { config } from '../config.ts';
import { atsSource } from './providers/ats.ts';
import { avitoSource } from './providers/avito.ts';
import { geekjobSource } from './providers/geekjob.ts';
import { habrSource } from './providers/habr.ts';
import { hhSource } from './providers/hh.ts';
import { hireHiSource } from './providers/hirehi.ts';
import { kasperskySource } from './providers/kaspersky.ts';
import { konturSource } from './providers/kontur.ts';
import { magnitSource } from './providers/magnit.ts';
import { mtsSource } from './providers/mts.ts';
import { ozonSource } from './providers/ozon.ts';
import { rabotaSource } from './providers/rabota.ts';
import { rwbSource } from './providers/rwb.ts';
import { sberSource } from './providers/sber.ts';
import { selectelSource } from './providers/selectel.ts';
import { tbankSource } from './providers/tbank.ts';
import { trudvsemSource } from './providers/trudvsem.ts';
import { vkSource } from './providers/vk.ts';
import { yadroSource } from './providers/yadro.ts';
import { yandexSource } from './providers/yandex.ts';

const additionalPages = { maxPages: config.additionalMaxPages };
export const sourceProviders = [
  hhSource({
    areaId: config.hhAreaId,
    maxPages: config.hhMaxPages,
    browserDataPath: config.hhBrowserDataPath,
    operationTimeoutSeconds: config.hhOperationTimeoutSeconds,
    playwrightHeadless: config.playwrightHeadless,
    playwrightChromiumPath: config.playwrightChromiumPath,
    timezone: config.timezone,
    browserEnvironment: {
      lang: process.env.LANG ?? 'C.UTF-8',
      path: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      tmpdir: process.env.TMPDIR ?? '/tmp',
    },
  }),
  habrSource(additionalPages),
  rabotaSource(additionalPages),
  hireHiSource({ maxPages: config.hireHiMaxPages }),
  geekjobSource(additionalPages),
  avitoSource(additionalPages),
  trudvsemSource({ ...additionalPages, region: process.env.TRUDVSEM_REGION?.trim() || undefined }),
  atsSource({ boards: (process.env.ATS_BOARDS ?? '').split(',').map((entry) => entry.trim()).filter(Boolean) }),
  yandexSource(additionalPages),
  ozonSource(additionalPages),
  rwbSource(additionalPages),
  mtsSource(additionalPages),
  vkSource(additionalPages),
  konturSource(additionalPages),
  magnitSource(additionalPages),
  yadroSource(additionalPages),
  selectelSource(additionalPages),
  sberSource(additionalPages),
  kasperskySource(additionalPages),
  tbankSource(additionalPages),
];
const availableProviderIds = new Set(sourceProviders.map((provider) => provider.id));
const unknownProviderIds = config.searchPlatforms.filter((id) => !availableProviderIds.has(id));
if (unknownProviderIds.length) {
  throw new Error(`Unknown SEARCH_PLATFORMS values: ${unknownProviderIds.join(', ')}`);
}
export const enabledSourceProviderIds = [...config.searchPlatforms];
export const sourceUrlPolicy = createSourceUrlPolicy(sourceProviders);
