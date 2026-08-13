import type { JobseekerExtensionApi } from '../extension-api.ts';

export type HhToolkitApi = JobseekerExtensionApi;

export let AdaptiveTaskPool: JobseekerExtensionApi['concurrency']['AdaptiveTaskPool'];
export let assertPublicAddress: JobseekerExtensionApi['sources']['assertPublicAddress'];
export let createSourceProvider: JobseekerExtensionApi['sources']['createSourceProvider'];
export let hashedVacancy: JobseekerExtensionApi['sources']['hashedVacancy'];
export let jobPostings: JobseekerExtensionApi['sources']['jobPostings'];
export let parseSalaryText: JobseekerExtensionApi['sources']['parseSalaryText'];
export let parseSourceKey: JobseekerExtensionApi['sources']['parseSourceKey'];
export let parseSourceVacancyId: JobseekerExtensionApi['sources']['parseSourceVacancyId'];
export let plainText: JobseekerExtensionApi['sources']['plainText'];
export let russianDate: JobseekerExtensionApi['sources']['russianDate'];
export let VacancySearchCollector: JobseekerExtensionApi['sources']['VacancySearchCollector'];

let initialized = false;
export function initToolkit(api: HhToolkitApi): void {
  if (initialized) return;
  ({ assertPublicAddress, createSourceProvider, hashedVacancy, jobPostings, parseSalaryText, parseSourceKey,
    parseSourceVacancyId, plainText, russianDate, VacancySearchCollector } = api.sources);
  ({ AdaptiveTaskPool } = api.concurrency);
  initialized = true;
}

export function assertToolkitInitialized(): void {
  if (!initialized) throw new Error('HH toolkit must be initialized before provider construction.');
}

export default function register(): void {}
