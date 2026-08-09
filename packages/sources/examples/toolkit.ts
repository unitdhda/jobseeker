/**
 * Live bindings filled from the injected extension api, so these examples run unchanged after being copied into a
 * deployment's extensions directory. The built application bundles its workspace packages, and none of them is
 * published, so an extension cannot import `@jobseeker/sources` at runtime — but type-only imports are erased on
 * load and stay legal. Every example therefore keeps ordinary named imports against this module, and the register
 * function assigns the real implementations before any provider is constructed.
 *
 * The loader imports every module in an extension directory, so this file carries a no-op default export.
 */
import type * as SourcesLib from '@jobseeker/sources';
import type * as ApiDriver from '@jobseeker/sources/drivers/api';
import type * as AtsDriver from '@jobseeker/sources/drivers/ats';
import type * as CompanySiteDriver from '@jobseeker/sources/drivers/company-site';
import type * as JsonLdBoardDriver from '@jobseeker/sources/drivers/jsonld-board';

/**
 * The slice of the application's extension api these examples use. Declared here rather than imported, because a
 * domain package must never reach into the application; `tests/package-boundaries.test.ts` checks that the real
 * `JobseekerExtensionApi` still satisfies this shape.
 */
export interface SourceExtensionApi {
  registerSourceProvider(provider: SourcesLib.AnySourceProvider): void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly sources: typeof SourcesLib & {
    drivers: {
      api: typeof ApiDriver;
      ats: typeof AtsDriver;
      companySite: typeof CompanySiteDriver;
      jsonLdBoard: typeof JsonLdBoardDriver;
    };
  };
}

export let asObject: typeof SourcesLib.asObject;
export let createSourceProvider: typeof SourcesLib.createSourceProvider;
export let hashedVacancy: typeof SourcesLib.hashedVacancy;
export let htmlText: typeof SourcesLib.htmlText;
export let jobPostings: typeof SourcesLib.jobPostings;
export let plainText: typeof SourcesLib.plainText;
export let russianDate: typeof SourcesLib.russianDate;
export let sourceUserAgent: typeof SourcesLib.sourceUserAgent;
export let structuredVacancy: typeof SourcesLib.structuredVacancy;
export let VacancySearchCollector: typeof SourcesLib.VacancySearchCollector;

export let createApiSource: typeof ApiDriver.createApiSource;

export let atsHosts: typeof AtsDriver.atsHosts;
export let atsProviders: typeof AtsDriver.atsProviders;
export let atsSearchProfileSchema: typeof AtsDriver.atsSearchProfileSchema;
export let configuredBoards: typeof AtsDriver.configuredBoards;
export let createAtsSource: typeof AtsDriver.createAtsSource;
/** Re-exported from the shared board helpers by both drivers, so one binding serves both call sites. */
export let postingMatchesQuery: typeof AtsDriver.postingMatchesQuery;

export let companyVacancyInput: typeof CompanySiteDriver.companyVacancyInput;
export let createCompanySiteSource: typeof CompanySiteDriver.createCompanySiteSource;
export let mainVacancyText: typeof CompanySiteDriver.mainVacancyText;

export let createJsonLdBoardSource: typeof JsonLdBoardDriver.createJsonLdBoardSource;

/** Idempotent: every example calls this at the top of its own register, and only the first assignment matters. */
export function initToolkit(api: SourceExtensionApi): void {
  ({ asObject, createSourceProvider, hashedVacancy, htmlText, jobPostings, plainText, russianDate,
    sourceUserAgent, structuredVacancy, VacancySearchCollector } = api.sources);
  ({ createApiSource } = api.sources.drivers.api);
  ({ atsHosts, atsProviders, atsSearchProfileSchema, configuredBoards, createAtsSource,
    postingMatchesQuery } = api.sources.drivers.ats);
  ({ companyVacancyInput, createCompanySiteSource, mainVacancyText } = api.sources.drivers.companySite);
  ({ createJsonLdBoardSource } = api.sources.drivers.jsonLdBoard);
}

/** Pages per search, shared by every paging example. */
export function examplePages(api: SourceExtensionApi): number {
  const parsed = Number(api.env.ADDITIONAL_MAX_PAGES);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

/** `provider:slug` board entries; the ATS example discovers nothing without them. */
export function exampleAtsBoards(api: SourceExtensionApi): string[] {
  return (api.env.ATS_BOARDS ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
}

export default function register(): void {}
