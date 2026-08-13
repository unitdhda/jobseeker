declare const userIdBrand: unique symbol;
declare const sourceKeyBrand: unique symbol;
declare const sourceVacancyIdBrand: unique symbol;
declare const currencyCodeBrand: unique symbol;
declare const sha256Brand: unique symbol;

export type UserId = string & {
  readonly [userIdBrand]: 'UserId';
};

export type SourceKey = string & {
  readonly [sourceKeyBrand]: 'SourceKey';
};

export type SourceVacancyId = string & {
  readonly [sourceVacancyIdBrand]: 'SourceVacancyId';
};

export type CurrencyCode = string & {
  readonly [currencyCodeBrand]: 'CurrencyCode';
};

type Sha256Hex<Purpose extends string> = string & {
  readonly [sha256Brand]: Purpose;
};

export type CvContentHash = Sha256Hex<'cv-content'>;
export type VacancyContentHash = Sha256Hex<'vacancy-content'>;
export type VacancyListingHash = Sha256Hex<'vacancy-listing'>;

const canonicalUserId = /^[1-9]\d*$/;
const canonicalSourceKey = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const canonicalCurrencyCode = /^[A-Z]{3}$/;
const canonicalSha256Hex = /^[0-9a-f]{64}$/;
const controlCharacter = /[\u0000-\u001f\u007f]/;

function receivedDescription(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return `a string of length ${value.length}`;
  if (Array.isArray(value)) return 'an array';
  return `a value of type ${typeof value}`;
}

/** Validates canonical Telegram ID syntax, not user existence or approval. */
export function parseUserId(value: unknown): UserId {
  if (typeof value !== 'string') {
    throw new TypeError(`Invalid user ID: expected a canonical decimal string, received ${receivedDescription(value)}.`);
  }
  if (!canonicalUserId.test(value)) {
    throw new TypeError('Invalid user ID: expected a positive decimal string without a sign, whitespace, or leading zeroes.');
  }
  if (BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError(`Invalid user ID: value exceeds the maximum safe Telegram ID ${Number.MAX_SAFE_INTEGER}.`);
  }
  return value as UserId;
}

/** Validates an application-controlled, extension-safe source key. */
export function parseSourceKey(value: unknown): SourceKey {
  if (typeof value !== 'string') {
    throw new TypeError(`Invalid source key: expected a string, received ${receivedDescription(value)}.`);
  }
  if (!canonicalSourceKey.test(value)) {
    throw new TypeError('Invalid source key: expected 1–64 lowercase ASCII letters, digits, dots, underscores, or hyphens, beginning with a letter or digit.');
  }
  return value as SourceKey;
}

/** Preserves the provider's opaque identifier without normalization. */
export function parseSourceVacancyId(value: unknown): SourceVacancyId {
  if (typeof value !== 'string') {
    throw new TypeError(`Invalid source vacancy ID: expected a string, received ${receivedDescription(value)}.`);
  }
  if (value.length === 0) {
    throw new TypeError('Invalid source vacancy ID: the identifier must not be empty.');
  }
  if (value.length > 512) {
    throw new TypeError(`Invalid source vacancy ID: expected at most 512 characters, received ${value.length}.`);
  }
  if (value.trim() !== value) {
    throw new TypeError('Invalid source vacancy ID: leading and trailing whitespace are not allowed.');
  }
  if (controlCharacter.test(value)) {
    throw new TypeError('Invalid source vacancy ID: ASCII control characters are not allowed.');
  }
  return value as SourceVacancyId;
}

/** Validates canonical ISO 4217-style syntax; it does not maintain a currency catalogue. */
export function parseCurrencyCode(value: unknown): CurrencyCode {
  if (typeof value !== 'string') {
    throw new TypeError(`Invalid currency code: expected a string, received ${receivedDescription(value)}.`);
  }
  if (!canonicalCurrencyCode.test(value)) {
    throw new TypeError('Invalid currency code: expected exactly three uppercase ASCII letters in ISO 4217 style.');
  }
  return value as CurrencyCode;
}

export function parseCvContentHash(value: unknown): CvContentHash {
  if (typeof value !== 'string' || !canonicalSha256Hex.test(value)) {
    throw new TypeError(`Invalid CV content hash: expected 64 lowercase hexadecimal SHA-256 characters, received ${receivedDescription(value)}.`);
  }
  return value as CvContentHash;
}

export function parseVacancyContentHash(value: unknown): VacancyContentHash {
  if (typeof value !== 'string' || !canonicalSha256Hex.test(value)) {
    throw new TypeError(`Invalid vacancy content hash: expected 64 lowercase hexadecimal SHA-256 characters, received ${receivedDescription(value)}.`);
  }
  return value as VacancyContentHash;
}

export function parseVacancyListingHash(value: unknown): VacancyListingHash {
  if (typeof value !== 'string' || !canonicalSha256Hex.test(value)) {
    throw new TypeError(`Invalid vacancy listing hash: expected 64 lowercase hexadecimal SHA-256 characters, received ${receivedDescription(value)}.`);
  }
  return value as VacancyListingHash;
}

export interface SearchRecipient {
  readonly userId: UserId;
  readonly searchName: string;
}

export interface PlannedSearch<TSearch> {
  readonly search: TSearch;
  readonly recipients: readonly SearchRecipient[];
}

export interface SearchPlan<TSearch> {
  readonly searches: readonly PlannedSearch<TSearch>[];
}

export interface VacancySourceIdentity {
  readonly source: SourceKey;
  readonly sourceId: SourceVacancyId;
}

export type SalaryPeriod =
  | 'hour'
  | 'day'
  | 'week'
  | 'month'
  | 'year'
  | 'unspecified';

export interface SalaryRange {
  /**
   * At least one bound must be present. When both are present,
   * `from` must not exceed `to`.
   */
  readonly from: number | null;
  readonly to: number | null;
  readonly currency: CurrencyCode;
  readonly gross: boolean | null;
  readonly period: SalaryPeriod;
}

export type ExperienceRequirement =
  | {
      readonly kind: 'unspecified';
    }
  | {
      readonly kind: 'range';
      readonly minimumYears: number;
      readonly maximumYears: number | null;
    }
  | {
      /**
       * A meaningful provider requirement that cannot be represented
       * faithfully as a numeric range.
       */
      readonly kind: 'other';
      readonly label: string;
    };

export type EmploymentType =
  | 'full-time'
  | 'part-time'
  | 'contract'
  | 'temporary'
  | 'internship'
  | 'volunteer'
  | 'other'
  | 'unspecified';

export type WorkSchedule =
  | 'standard'
  | 'shift'
  | 'flexible'
  | 'rotational'
  | 'other'
  | 'unspecified';

export type WorkFormat =
  | 'on-site'
  | 'remote'
  | 'hybrid'
  | 'field'
  | 'other'
  | 'unspecified';

export type VacancyStatus =
  | 'discovered'
  | 'queued'
  | 'filtered'
  | 'normalizing'
  | 'normalized'
  | 'duplicate'
  | 'failed'
  | 'closed';

export interface VacancyContent extends VacancySourceIdentity {
  readonly name: string;
  readonly employer: string;
  readonly area: string;

  readonly salary: SalaryRange | null;
  readonly experience: ExperienceRequirement;
  readonly employment: EmploymentType;
  readonly schedule: WorkSchedule;
  readonly workFormat: WorkFormat;

  readonly description: string;
  readonly keySkills: readonly string[];

  readonly url: URL;
  readonly publishedAt: Date;

  /**
   * Provider query associated with discovery. This is provenance and
   * must not contribute to the vacancy content hash.
   */
  readonly sourceQuery: string;
}

export interface VacancyInput extends VacancyContent {
  readonly contentHash: VacancyContentHash;
}

export interface VacancyCandidateInput extends VacancySourceIdentity {
  readonly url: URL;
  readonly searchName: string;
  readonly title: string;

  readonly summary?: string;
  readonly publishedAt?: Date;
  readonly payload?: unknown;
}

export interface VacancyCandidate
  extends Omit<VacancyCandidateInput, 'summary' | 'publishedAt'> {
  readonly summary: string;
  readonly publishedAt: Date;

  readonly listingHash: VacancyListingHash;
  readonly status: VacancyStatus;

  /** Nonnegative integer, enforced at the runtime boundary. */
  readonly attempts: number;

  /** Null before matching; otherwise 0..100, enforced at the runtime boundary. */
  readonly combinedScore: number | null;
}
