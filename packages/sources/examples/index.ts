import { atsSource } from './ats.ts';
import { avitoSource } from './avito.ts';
import { geekjobSource } from './geekjob.ts';
import { habrSource } from './habr.ts';
import { hireHiSource } from './hirehi.ts';
import { kasperskySource } from './kaspersky.ts';
import { konturSource } from './kontur.ts';
import { magnitSource } from './magnit.ts';
import { mtsSource } from './mts.ts';
import { ozonSource } from './ozon.ts';
import { rabotaSource } from './rabota.ts';
import { rwbSource } from './rwb.ts';
import { sberSource } from './sber.ts';
import { selectelSource } from './selectel.ts';
import { tbankSource } from './tbank.ts';
import { trudvsemSource } from './trudvsem.ts';
import { vkSource } from './vk.ts';
import { yadroSource } from './yadro.ts';
import { yandexSource } from './yandex.ts';
import { exampleAtsBoards, examplePages, initToolkit, type SourceExtensionApi } from './toolkit.ts';

export {
  atsSource, avitoSource, geekjobSource, habrSource, hireHiSource, kasperskySource, konturSource, magnitSource,
  mtsSource, ozonSource, rabotaSource, rwbSource, sberSource, selectelSource, tbankSource, trudvsemSource,
  vkSource, yadroSource, yandexSource,
};

export interface ExampleSourceOptions {
  readonly maxPages?: number;
  readonly atsBoards?: readonly string[];
  readonly trudvsemRegion?: string;
}

/** Returns fresh providers in the documented catalogue order. `initToolkit(api)` must run first. */
export function exampleSources(options: ExampleSourceOptions = {}) {
  const pages = { maxPages: options.maxPages };
  return Object.freeze([
    habrSource(pages), rabotaSource(pages), hireHiSource(pages), geekjobSource(pages), avitoSource(pages),
    trudvsemSource({ ...pages, region: options.trudvsemRegion }), atsSource({ boards: options.atsBoards ?? [] }),
    yandexSource(pages), ozonSource(pages), rwbSource(pages), mtsSource(pages), vkSource(pages), konturSource(pages),
    magnitSource(pages), yadroSource(pages), selectelSource(pages), sberSource(pages), kasperskySource(pages),
    tbankSource(pages),
  ]);
}

/** Whole-folder entry point. Do not combine it with flat copies of individual provider files. */
export default function register(api: SourceExtensionApi): void {
  initToolkit(api);
  for (const provider of exampleSources({
    maxPages: examplePages(api), atsBoards: exampleAtsBoards(api),
    trudvsemRegion: api.env.TRUDVSEM_REGION?.trim() || undefined,
  })) api.registerSourceProvider(provider);
}
