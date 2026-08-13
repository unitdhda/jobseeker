import type * as SourcesLib from '@jobseeker/sources';
import type * as ApiDriver from '@jobseeker/sources/drivers/api';
import type * as AtsDriver from '@jobseeker/sources/drivers/ats';
import type * as CompanySiteDriver from '@jobseeker/sources/drivers/company-site';
import type * as JsonLdBoardDriver from '@jobseeker/sources/drivers/jsonld-board';

/** The app API slice available to deployment-copied source examples. All workspace imports above erase at runtime. */
export interface SourceExtensionApi {
  registerSourceProvider(provider: SourcesLib.AnySourceProvider): void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly sources: typeof SourcesLib & {
    readonly drivers: {
      readonly api: typeof ApiDriver;
      readonly ats: typeof AtsDriver;
      readonly companySite: typeof CompanySiteDriver;
      readonly jsonLdBoard: typeof JsonLdBoardDriver;
    };
  };
}

let initialized = false;

export let asObject: typeof SourcesLib.asObject;
export let createSourceProvider: typeof SourcesLib.createSourceProvider;
export let hashedVacancy: typeof SourcesLib.hashedVacancy;
export let htmlText: typeof SourcesLib.htmlText;
export let jobPostings: typeof SourcesLib.jobPostings;
export let parseSalaryText: typeof SourcesLib.parseSalaryText;
export let parseSourceKey: typeof SourcesLib.parseSourceKey;
export let parseSourceVacancyId: typeof SourcesLib.parseSourceVacancyId;
export let plainText: typeof SourcesLib.plainText;
export let russianDate: typeof SourcesLib.russianDate;
export let structuredLocation: typeof SourcesLib.structuredLocation;
export let structuredVacancy: typeof SourcesLib.structuredVacancy;
export let VacancySearchCollector: typeof SourcesLib.VacancySearchCollector;

export let createApiSource: typeof ApiDriver.createApiSource;
export let atsHosts: typeof AtsDriver.atsHosts;
export let atsSearchProfileSchema: typeof AtsDriver.atsSearchProfileSchema;
export let configuredBoards: typeof AtsDriver.configuredBoards;
export let createAtsSource: typeof AtsDriver.createAtsSource;
export let postingMatchesQuery: typeof AtsDriver.postingMatchesQuery;
export let companyVacancyInput: typeof CompanySiteDriver.companyVacancyInput;
export let createCompanySiteSource: typeof CompanySiteDriver.createCompanySiteSource;
export let mainVacancyText: typeof CompanySiteDriver.mainVacancyText;
export let createJsonLdBoardSource: typeof JsonLdBoardDriver.createJsonLdBoardSource;

/** Every independently copied provider calls this before constructing its fresh provider instance. */
export function initToolkit(api: SourceExtensionApi): void {
  if (initialized) return;
  ({ asObject, createSourceProvider, hashedVacancy, htmlText, jobPostings, parseSalaryText, parseSourceKey,
    parseSourceVacancyId, plainText, russianDate, structuredLocation, structuredVacancy, VacancySearchCollector } = api.sources);
  ({ createApiSource } = api.sources.drivers.api);
  ({ atsHosts, atsSearchProfileSchema, configuredBoards, createAtsSource, postingMatchesQuery } = api.sources.drivers.ats);
  ({ companyVacancyInput, createCompanySiteSource, mainVacancyText } = api.sources.drivers.companySite);
  ({ createJsonLdBoardSource } = api.sources.drivers.jsonLdBoard);
  initialized = true;
}

export function assertToolkitInitialized(): void {
  if (!initialized) throw new Error('Source example toolkit must be initialized by register(api) before provider construction.');
}

export function examplePages(api: SourceExtensionApi): number {
  const parsed = Number(api.env.ADDITIONAL_MAX_PAGES);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 100 ? parsed : 1;
}

export function exampleAtsBoards(api: SourceExtensionApi): readonly string[] {
  return Object.freeze((api.env.ATS_BOARDS ?? '').split(',').map((entry) => entry.trim()).filter(Boolean));
}

/** Shared helper files are ignored safely when copied beside selected provider modules. */
export default function register(): void {}
