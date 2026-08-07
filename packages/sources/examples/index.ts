/**
 * Reference source providers, kept as working examples rather than a wired-in catalogue: nothing here registers
 * itself. An extension picks the factories it wants and registers them in its collection; a deployment without an
 * extension has no sources at all. Every example is fetch-based — browser-backed sources belong in extensions with
 * their own dependencies.
 */
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

export {
  atsSource, avitoSource, geekjobSource, habrSource, hireHiSource, kasperskySource, konturSource, magnitSource,
  mtsSource, ozonSource, rabotaSource, rwbSource, sberSource, selectelSource, tbankSource, trudvsemSource,
  vkSource, yadroSource, yandexSource,
};

export interface ExampleSourceOptions {
  maxPages?: number;
  /** `provider:slug` ATS board entries; the ATS example discovers nothing without them. */
  atsBoards?: readonly string[];
  /** Работа России federal region code. */
  trudvsemRegion?: string;
}

/** Every example provider, constructed fresh. Callers register the subset they want. */
export function exampleSources(options: ExampleSourceOptions = {}) {
  const pages = { maxPages: options.maxPages };
  return [
    habrSource(pages),
    rabotaSource(pages),
    hireHiSource(pages),
    geekjobSource(pages),
    avitoSource(pages),
    trudvsemSource({ ...pages, region: options.trudvsemRegion }),
    atsSource({ boards: options.atsBoards ?? [] }),
    yandexSource(pages),
    ozonSource(pages),
    rwbSource(pages),
    mtsSource(pages),
    vkSource(pages),
    konturSource(pages),
    magnitSource(pages),
    yadroSource(pages),
    selectelSource(pages),
    sberSource(pages),
    kasperskySource(pages),
    tbankSource(pages),
  ];
}
