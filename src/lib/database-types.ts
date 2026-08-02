import type { CanonicalCvDocument, CvSourceFormat } from './cv-adapters.ts';

export type UserStatus = 'unregistered' | 'pending' | 'approved' | 'rejected' | 'revoked';
export interface TelegramUser {
  userId: string; chatId: string; username: string | null; displayName: string;
  status: UserStatus; isOwner: boolean; requestedAt: string | null; approvedAt: string | null;
}
export interface TelegramIdentity { userId: string; chatId: string; username?: string; displayName: string }
export interface AccessRequestResult { user: TelegramUser; notifyOwner: boolean; retryAfterSeconds: number }
export type UsageKind = 'score' | 'application' | 'search-profile';
export interface UserUsageSummary {
  userId: string; displayName: string; scores24h: number; applications24h: number;
  searchProfiles24h: number; scoresTotal: number; applicationsTotal: number;
}
export interface Vacancy {
  id: number; source: string; sourceId: string; applyId: string; name: string; employer: string; area: string;
  salaryFrom: number | null; salaryTo: number | null; salaryCurrency: string | null; salaryGross: boolean | null;
  experience: string; employment: string; schedule: string; workFormat: string; description: string; keySkills: string[];
  url: string; publishedAt: string; sourceQuery: string; contentHash: string; decision: string;
}
export interface VacancyInput extends Omit<Vacancy, 'id' | 'applyId' | 'decision'> {}
export interface CvSource {
  cvSha256: string; cvText: string; document: CanonicalCvDocument;
  sourceFormat: CvSourceFormat; originalFilename: string; mediaType: string; parserName: string; parserVersion: string;
}
export interface DeliverySettings {
  startMinutes: number; endMinutes: number; digestMinutes: number; timezone: string; lastDigestAt: string | null;
}
export interface VacancyCandidateInput {
  source: string; sourceId: string; url: string; searchName: string; title: string;
  summary?: string; publishedAt?: string; payload?: unknown;
}
export interface VacancyCandidate extends Omit<VacancyCandidateInput, 'summary' | 'publishedAt'> {
  summary: string; publishedAt: string; listingHash: string; status: string; attempts: number; combinedScore: number | null;
}
export interface PrefilterScoreInput {
  regexScore: number; lexicalCosine: number; lexicalScore: number; combinedScore: number;
  filtered: boolean; auditSelected: boolean; reasons: string[];
}
export interface PrefilteredVacancy extends Vacancy { prefilterScore: number; auditSelected: boolean }
export interface PrefilterCalibration {
  compared: number; correlation: number | null; audited: number; auditFalseNegatives: number;
  applied: number; skipped: number; feedbackLabels: number; readyForAdjustment: boolean;
}
export interface ScoredVacancy extends Vacancy { userId: string; score: number }
export interface AlertVacancy extends ScoredVacancy {
  primaryTrack: string; summary: string; reasons: string[]; gaps: string[];
}
