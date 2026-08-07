/**
 * Live bindings filled from the injected extension api. The built application bundles its workspace packages, so
 * an extension cannot import them at runtime; type-only imports are erased and stay legal. hh.ts keeps ordinary
 * named imports against this module, and index.ts assigns the real implementations before anything runs.
 */
import type * as SourcesLib from '@jobseeker/sources';
import type { AdaptiveTaskPool as AdaptiveTaskPoolClass } from '@jobseeker/engine/concurrency';

export interface HhToolkitApi {
  sources: typeof SourcesLib;
  concurrency: { AdaptiveTaskPool: typeof AdaptiveTaskPoolClass };
}

export let assertPublicAddress: typeof SourcesLib.assertPublicAddress;
export let createSourceProvider: typeof SourcesLib.createSourceProvider;
export let jobPostings: typeof SourcesLib.jobPostings;
export let plainText: typeof SourcesLib.plainText;
export let russianDate: typeof SourcesLib.russianDate;
export let VacancySearchCollector: typeof SourcesLib.VacancySearchCollector;
export let AdaptiveTaskPool: typeof AdaptiveTaskPoolClass;

export function initToolkit(api: HhToolkitApi): void {
  ({ assertPublicAddress, createSourceProvider, jobPostings, plainText, russianDate,
    VacancySearchCollector } = api.sources);
  ({ AdaptiveTaskPool } = api.concurrency);
}
