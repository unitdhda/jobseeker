/** Path shim: the helpers moved into @jobseeker/sources; existing importers keep this path. */
export {
  assertPublicAddress, fetchSourceHtml, fetchSourceJson, hashedVacancy, htmlText, jobPostings, plainText,
  readResponseBytes, russianDate, safeVacancyUrl, sourceUrl, structuredVacancy, VacancySearchCollector,
  asObject, type JsonObject,
} from '@jobseeker/sources';
