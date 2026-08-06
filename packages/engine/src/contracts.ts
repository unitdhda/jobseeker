/** Data and port contracts shared by the engine, source adapters, and persistence. */
export interface SearchRecipient { userId: string; searchName: string }
export interface PlannedSearch<T> { search: T; recipients: SearchRecipient[] }
export interface SearchPlan<T> { searches: PlannedSearch<T>[] }

export interface VacancyContent {
  source: string;
  sourceId: string;
  name: string;
  employer: string;
  area: string;
  salaryFrom: number | null;
  salaryTo: number | null;
  salaryCurrency: string | null;
  salaryGross: boolean | null;
  experience: string;
  employment: string;
  schedule: string;
  workFormat: string;
  description: string;
  keySkills: string[];
  url: string;
  publishedAt: string;
  sourceQuery: string;
  contentHash: string;
}

export interface VacancyInput extends VacancyContent {}

export interface VacancyCandidateInput {
  source: string;
  sourceId: string;
  url: string;
  searchName: string;
  title: string;
  summary?: string;
  publishedAt?: string;
  payload?: unknown;
}

export interface VacancyCandidate extends Omit<VacancyCandidateInput, 'summary' | 'publishedAt'> {
  summary: string;
  publishedAt: string;
  listingHash: string;
  status: string;
  attempts: number;
  combinedScore: number | null;
}
