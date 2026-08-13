export { parseSourceKey, parseSourceVacancyId } from '@jobseeker/engine/contracts';
export type { SourceContext, SourceLimits, SourcesOptions } from './context.ts';
export { createSourceContext } from './context.ts';
export type {
  PlanOptions,
  PlatformDiscoveryResult,
  PlatformProfile,
  PlatformSearch,
  PlatformValidationTemplate,
  SearchPlatform,
  SourceSchema,
  UserSearches,
  VacancyPlatform,
} from './contract.ts';
export type { PlannedSearch, SearchPlan, SearchRecipient } from './contract.ts';
export type {
  JsonObject,
  SourceHostDeclaration,
  SourceHttp,
  SourceHttpDependencies,
  SourceUrlPolicy,
  VacancySearchResult,
} from './http.ts';
export {
  asObject,
  assertPublicAddress,
  createSourceHttp,
  createSourceUrlPolicy,
  fetchSourceHtml,
  fetchSourceJson,
  fetchSourceResponse,
  fetchSourceText,
  hashedVacancy,
  htmlText,
  isPublicIpAddress,
  jobPostings,
  maximumSourceBytes,
  parseSalaryText,
  plainText,
  readResponseBytes,
  russianDate,
  sourceUserAgent,
  structuredLocation,
  structuredVacancy,
  VacancySearchCollector,
} from './http.ts';
export type {
  AnySourceProvider,
  AnyVacancyPlatform,
  CreateSourceProviderOptions,
  MutableSources,
  SourceProvider,
  Sources,
} from './sources.ts';
export { createSourceProvider, createSources } from './sources.ts';
export type {
  ApiListing,
  ApiListingPage,
  ApiRequestPhase,
  ApiSourceDefinition,
  ApiSourceOptions,
} from './drivers/api.ts';
export { createApiSource } from './drivers/api.ts';
export type {
  AtsBoardPosting,
  AtsProvider,
  AtsSearch,
  AtsSearchProfile,
  AtsSourceDefinition,
  AtsSourceOptions,
} from './drivers/ats.ts';
export {
  atsHosts,
  atsPlatform,
  atsProviders,
  atsSearchProfileSchema,
  configuredBoards,
  createAtsSource,
  normalizeAtsCandidate,
  postingMatchesQuery,
  readBoard,
  scrapeAts,
  smartRecruitersDescription,
} from './drivers/ats.ts';
export type {
  CompanyListing,
  CompanyListingPage,
  CompanySearch,
  CompanySearchProfile,
  CompanySite,
} from './companies.ts';
export {
  companyPlatform,
  companySearchProfileSchema,
  companyVacancyInput,
  createCompanySiteSource,
  mainVacancyText,
  normalizeCompanyCandidate,
  scrapeCompanySite,
} from './companies.ts';
export type { BoardEntry, BoardSearch, BoardSearchProfile, JsonLdBoard } from './boards.ts';
export {
  boardPlatform,
  boardSearchProfileSchema,
  normalizeJsonLdCandidate,
  scrapeJsonLdBoard,
} from './boards.ts';
export { createJsonLdBoardSource } from './drivers/jsonld-board.ts';
