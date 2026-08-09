/**
 * Reference source providers, kept as working examples rather than a wired-in catalogue. The application imports
 * nothing from this directory; a deployment copies what it wants into its extensions directory.
 *
 * Two ways to use these, and they must not be mixed in one directory:
 *
 * - copy the whole folder as a subdirectory (`extensions/examples/`). The loader then loads only this file, and
 *   the register below puts every example in play;
 * - copy individual providers next to `toolkit.ts`, `profile.ts`, and `text.ts`, leaving this file behind. Each
 *   provider registers itself, so a flat copy of all of them plus this file would register everything twice and
 *   fail on duplicate provider ids.
 *
 * Every example is fetch-based — browser-backed sources belong in an extension with its own dependencies.
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
import {
  exampleAtsBoards, examplePages, initToolkit, type SourceExtensionApi,
} from './toolkit.ts';

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

/** Registers every example at once; the entry point when this folder is copied whole. */
export default function register(api: SourceExtensionApi): void {
  initToolkit(api);
  for (const provider of exampleSources({
    maxPages: examplePages(api),
    atsBoards: exampleAtsBoards(api),
    trudvsemRegion: api.env.TRUDVSEM_REGION?.trim() || undefined,
  })) api.registerSourceProvider(provider);
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
