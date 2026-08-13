import * as v from 'valibot';
import { searchTokens } from './canon.ts';
import {
  parseCvContentHash,
  type CvContentHash,
  type ExperienceRequirement,
  type VacancyContent,
} from './contracts.ts';
import { identityRoleResolver, type RoleTokenResolver } from './equivalence.ts';
import { tokenSimilarity } from './identity.ts';
import {
  idfWeightedCosine,
  titleSpecificity,
  type IdfLookups,
} from './idf.ts';

export const careerProfileLimits = {
  tracks: 10,
  titleVariants: 16,
  coreSkills: 30,
  evidence: 8,
} as const;

const labelSchema = v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(100));
const titleVariantSchema = v.pipe(
  labelSchema,
  v.check(
    (value) => !/\s[\/|]\s/.test(value),
    'Each title variant must contain one title in one language; put translations in separate array items.',
  ),
);
const evidenceSchema = v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(300));

export const careerTrackSchema = v.strictObject({
  name: labelSchema,
  titleVariants: v.pipe(
    v.array(titleVariantSchema),
    v.minLength(1),
    v.maxLength(careerProfileLimits.titleVariants),
  ),
  coreSkills: v.pipe(v.array(labelSchema), v.maxLength(careerProfileLimits.coreSkills)),
  evidence: v.pipe(
    v.array(evidenceSchema),
    v.minLength(1),
    v.maxLength(careerProfileLimits.evidence),
  ),
});

export const careerProfileSchema = v.strictObject({
  version: v.literal(1),
  tracks: v.pipe(
    v.array(careerTrackSchema),
    v.minLength(1),
    v.maxLength(careerProfileLimits.tracks),
  ),
});

export type CareerTrack = v.InferOutput<typeof careerTrackSchema>;
export type CareerProfile = v.InferOutput<typeof careerProfileSchema>;

export interface StoredCareerProfile {
  readonly cvHash: CvContentHash;
  readonly profile: CareerProfile;
}

const packedTitleSeparator = /\s+[\/|]\s+/;

function deduplicateStrings(values: readonly unknown[]): unknown[] {
  const seen = new Set<string>();
  const result: unknown[] = [];

  for (const value of values) {
    if (typeof value !== 'string') {
      result.push(value);
      continue;
    }

    const trimmed = value.trim();
    const key = trimmed.normalize('NFKC').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function normalizeTrack(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;

  const track = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = { ...track };

  if (Array.isArray(track.titleVariants)) {
    const split = track.titleVariants.flatMap((title): unknown[] =>
      typeof title === 'string' ? title.split(packedTitleSeparator) : [title]);
    normalized.titleVariants = deduplicateStrings(split).slice(0, careerProfileLimits.titleVariants);
  }
  if (Array.isArray(track.coreSkills)) {
    normalized.coreSkills = deduplicateStrings(track.coreSkills).slice(0, careerProfileLimits.coreSkills);
  }
  if (Array.isArray(track.evidence)) {
    normalized.evidence = deduplicateStrings(track.evidence).slice(0, careerProfileLimits.evidence);
  }

  return normalized;
}

/** Repairs bounded, repeated model-output mistakes without inventing missing profile evidence. */
export function normalizeCareerProfileJson(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;

  const root = value as Record<string, unknown>;
  if (!Array.isArray(root.tracks)) return value;

  const tracks = root.tracks.map(normalizeTrack).slice(0, careerProfileLimits.tracks);
  return { ...root, tracks };
}

const storedCareerProfileSchema = v.strictObject({
  cvHash: v.string(),
  profile: careerProfileSchema,
});

/** Validates persisted profile data and rejects data derived from a superseded CV. */
export function parseStoredCareerProfile(value: unknown, expectedCvHash: CvContentHash): StoredCareerProfile {
  const parsed = v.parse(storedCareerProfileSchema, value);
  const cvHash = parseCvContentHash(parsed.cvHash);
  if (cvHash !== expectedCvHash) {
    throw new TypeError('Invalid stored career profile: CV hash does not match the authoritative CV.');
  }
  return Object.freeze({ cvHash, profile: parsed.profile });
}

export type RecencyBand = 'today' | 'week' | 'fortnight' | 'month' | 'stale';

export interface VacancyRecency {
  readonly band: RecencyBand;
  readonly days: number;
  readonly weight: number;
  readonly expired: boolean;
  readonly label: string;
}

export interface PrefilterResult {
  readonly regexScore: number;
  readonly lexicalCosine: number;
  readonly lexicalScore: number;
  readonly combinedScore: number;
  readonly titleSimilarity: number;
  readonly skillCoverage: number;
  readonly seniorityGap: number | null;
  readonly specificity: number | null;
  readonly lexicalCosineIdf: number | null;
  readonly filtered: boolean;
  readonly expired: boolean;
  readonly reasons: readonly string[];
}

const recencyBands: readonly {
  readonly band: RecencyBand;
  readonly withinDays: number;
  readonly weight: number;
  readonly label: string;
}[] = [
  { band: 'today', withinDays: 1, weight: 1, label: 'published today' },
  { band: 'week', withinDays: 7, weight: 1, label: 'published 1–7 days ago' },
  { band: 'fortnight', withinDays: 14, weight: 0.92, label: 'published 8–14 days ago' },
  { band: 'month', withinDays: 30, weight: 0.8, label: 'published 15–30 days ago' },
  { band: 'stale', withinDays: Number.POSITIVE_INFINITY, weight: 0.6, label: 'published over 30 days ago' },
];

function validTimestamp(date: Date, name: string): number {
  if (!(date instanceof Date)) throw new TypeError(`Invalid prefilter input: ${name} must be a Date.`);
  const timestamp = date.getTime();
  if (!Number.isFinite(timestamp)) throw new TypeError(`Invalid prefilter input: ${name} must be a valid Date.`);
  return timestamp;
}

export function vacancyRecency(
  vacancy: Pick<VacancyContent, 'publishedAt'>,
  now: Date = new Date(),
  maxAgeDays = 30,
): VacancyRecency {
  const nowMs = validTimestamp(now, 'now');
  if (!Number.isSafeInteger(maxAgeDays) || maxAgeDays < 1) {
    throw new RangeError(
      `Invalid prefilter maximum age: expected a positive safe integer number of days, received ${maxAgeDays}.`,
    );
  }

  const publishedMs = vacancy.publishedAt instanceof Date ? vacancy.publishedAt.getTime() : Number.NaN;
  const elapsedDays = Number.isFinite(publishedMs) && publishedMs <= nowMs
    ? (nowMs - publishedMs) / 86_400_000
    : 0;
  const selected = recencyBands.find((entry) => elapsedDays < entry.withinDays) ?? recencyBands.at(-1)!;
  return Object.freeze({
    band: selected.band,
    days: Math.floor(elapsedDays),
    weight: selected.weight,
    expired: elapsedDays >= maxAgeDays,
    label: selected.label,
  });
}

function normalizedEvidence(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function experienceEvidence(experience: ExperienceRequirement): string {
  if (experience.kind === 'unspecified') return 'experience unspecified';
  if (experience.kind === 'other') return `experience ${normalizedEvidence(experience.label)}`;
  const maximum = experience.maximumYears === null ? 'or more' : `to ${experience.maximumYears}`;
  return `experience ${experience.minimumYears} ${maximum} years`;
}

/** Concatenates only normalized vacancy evidence; identifiers, provenance, URLs, hashes, and dates are excluded. */
export function vacancySemanticText(vacancy: VacancyContent): string {
  return [
    vacancy.name,
    vacancy.employer,
    vacancy.area,
    experienceEvidence(vacancy.experience),
    vacancy.employment,
    vacancy.schedule,
    vacancy.workFormat,
    vacancy.description,
    ...vacancy.keySkills,
  ].map(normalizedEvidence).filter(Boolean).join('\n');
}

function lexicalScoreOf(cosine: number): number {
  return Math.min(100, Math.round(cosine * 300));
}

/** Implements the fixed admission arithmetic; recency and IDF remain diagnostics rather than hidden multipliers. */
export function combinedEvidenceScore(regexScore: number, lexicalCosine: number): number {
  if (!Number.isFinite(regexScore) || regexScore < 0 || regexScore > 100) {
    throw new RangeError(`Invalid regex score: expected a finite number from 0 through 100, received ${regexScore}.`);
  }
  if (!Number.isFinite(lexicalCosine) || lexicalCosine < 0 || lexicalCosine > 1) {
    throw new RangeError(`Invalid lexical cosine: expected a finite number from 0 through 1, received ${lexicalCosine}.`);
  }
  return Math.round(regexScore * 0.75 + lexicalScoreOf(lexicalCosine) * 0.25);
}

function relevanceText(value: string): string {
  return value
    .split(/\r?\n/u)
    .filter((line) => !/\b(?:contacts?|e-?mail|phone|telegram|whatsapp)\b|контакт|почт|телефон/iu.test(line))
    .join('\n')
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/gu, ' ')
    .replace(/\b(?:https?:\/\/|www\.)\S+/giu, ' ')
    .replace(/(?:\+?\d[\s().-]*){7,}/gu, ' ');
}

function plainWords(value: string): string[] {
  return relevanceText(value).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function plainWordCounts(value: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of plainWords(value)) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

export function lexicalCosineSimilarity(leftText: string, rightText: string): number {
  const left = plainWordCounts(leftText);
  const right = plainWordCounts(rightText);
  if (left.size === 0 || right.size === 0) return 0;

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (const count of left.values()) leftMagnitude += count * count;
  for (const count of right.values()) rightMagnitude += count * count;
  for (const [token, count] of left) dot += count * (right.get(token) ?? 0);
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

export interface PrefilterOptions {
  readonly profile: CareerProfile;
  readonly minimumScore: number;
  readonly maxAgeDays: number;
  readonly now?: Date;
  readonly roleResolver?: RoleTokenResolver;
  readonly idfLookups?: IdfLookups;
}

const minimumTitleEvidence = 0.35;
const minimumSkillEvidence = 0.2;

const seniorityRanks = new Map<string, number>([
  ['intern', 0], ['internship', 0], ['стажер', 0], ['стажёр', 0],
  ['junior', 1], ['jr', 1], ['младший', 1],
  ['middle', 2], ['mid', 2], ['средний', 2],
  ['senior', 3], ['sr', 3], ['старший', 3],
  ['staff', 4], ['lead', 4], ['ведущий', 4],
  ['principal', 5], ['head', 5], ['chief', 5], ['главный', 5],
]);

function lexicalWords(value: string): string[] {
  return (value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}+#.]+/gu) ?? [])
    .map((token) => token.replace(/\.+$/u, ''))
    .filter(Boolean);
}

function containsSequence(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  outer: for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) continue outer;
    }
    return true;
  }
  return false;
}

function skillCoverageOf(track: CareerTrack, vacancy: VacancyContent): number {
  const uniqueSkills = new Map<string, readonly string[]>();
  for (const skill of track.coreSkills) {
    const words = lexicalWords(skill);
    if (words.length > 0) uniqueSkills.set(words.join('\0'), words);
  }
  if (uniqueSkills.size === 0) return 0;

  const titleAndDescription = lexicalWords(`${vacancy.name}\n${vacancy.description}`);
  const keySkills = vacancy.keySkills.map(lexicalWords);
  let matched = 0;
  for (const words of uniqueSkills.values()) {
    if (containsSequence(titleAndDescription, words)
      || keySkills.some((keySkill) => containsSequence(keySkill, words))) matched += 1;
  }
  return matched / uniqueSkills.size;
}

function titleSimilarityOf(
  track: CareerTrack,
  vacancyTitleTokens: readonly string[],
  resolver: RoleTokenResolver,
): number {
  let best = 0;
  for (const title of track.titleVariants) {
    const similarity = tokenSimilarity([...searchTokens(title)], vacancyTitleTokens, resolver);
    if (similarity > best) best = similarity;
  }
  return best;
}

function matchedTitleTokens(
  track: CareerTrack,
  vacancyTokens: readonly string[],
  resolver: RoleTokenResolver,
): string[] {
  const profileTokens = new Set(
    track.titleVariants.flatMap((title) => [...searchTokens(title)]).map(resolver),
  );
  return vacancyTokens.filter((token) => profileTokens.has(resolver(token)));
}

function seniorityRank(value: string): number | null {
  let highest: number | null = null;
  for (const token of lexicalWords(value)) {
    const rank = seniorityRanks.get(token);
    if (rank !== undefined && (highest === null || rank > highest)) highest = rank;
  }
  return highest;
}

function seniorityGapOf(track: CareerTrack, vacancyName: string): number | null {
  const vacancyRank = seniorityRank(vacancyName);
  if (vacancyRank === null) return null;

  let profileRank: number | null = null;
  for (const title of track.titleVariants) {
    const rank = seniorityRank(title);
    if (rank !== null && (profileRank === null || rank > profileRank)) profileRank = rank;
  }
  return profileRank === null ? null : (vacancyRank - profileRank) / 5;
}

function assertPrefilterOptions(options: PrefilterOptions): void {
  if (!Number.isFinite(options.minimumScore) || options.minimumScore < 0 || options.minimumScore > 100) {
    throw new RangeError(
      `Invalid prefilter minimum score: expected a finite number from 0 through 100, received ${options.minimumScore}.`,
    );
  }
  if (!Number.isSafeInteger(options.maxAgeDays) || options.maxAgeDays < 1) {
    throw new RangeError(
      `Invalid prefilter maximum age: expected a positive safe integer number of days, received ${options.maxAgeDays}.`,
    );
  }
}

/** Evaluates one normalized vacancy through one immutable career lens without storage, network, or model calls. */
export function prefilterVacancy(
  cvText: string,
  vacancy: VacancyContent,
  options: PrefilterOptions,
): PrefilterResult {
  assertPrefilterOptions(options);
  const resolver = options.roleResolver ?? identityRoleResolver;
  const vacancyTitleTokens = [...searchTokens(vacancy.name)];

  let selectedTrack: CareerTrack | undefined;
  let titleSimilarity = 0;
  let skillCoverage = 0;
  let regexScore = 0;

  for (const track of options.profile.tracks) {
    const trackTitleSimilarity = titleSimilarityOf(track, vacancyTitleTokens, resolver);
    const trackSkillCoverage = skillCoverageOf(track, vacancy);
    const trackRegexScore = Math.round((trackTitleSimilarity * 0.75 + trackSkillCoverage * 0.25) * 100);
    if (trackRegexScore > regexScore) {
      selectedTrack = track;
      titleSimilarity = trackTitleSimilarity;
      skillCoverage = trackSkillCoverage;
      regexScore = trackRegexScore;
    }
  }

  const lexicalCosine = lexicalCosineSimilarity(cvText, vacancySemanticText(vacancy));
  const lexicalScore = lexicalScoreOf(lexicalCosine);
  const combinedScore = combinedEvidenceScore(regexScore, lexicalCosine);
  const recency = vacancyRecency(vacancy, options.now ?? new Date(), options.maxAgeDays);
  const hasSkillEvidence = selectedTrack !== undefined
    && selectedTrack.coreSkills.length > 0
    && skillCoverage >= minimumSkillEvidence;
  const hasRoleOrSkillEvidence = titleSimilarity >= minimumTitleEvidence || hasSkillEvidence;
  const measuredIdf = options.idfLookups !== undefined
    && options.idfLookups.title.documents > 0
    && options.idfLookups.body.documents > 0;
  const specificity = measuredIdf && selectedTrack
    ? titleSpecificity(matchedTitleTokens(selectedTrack, vacancyTitleTokens, resolver), options.idfLookups!.title)
    : null;
  const lexicalCosineIdf = measuredIdf
    ? idfWeightedCosine(plainWords(cvText), plainWords(vacancySemanticText(vacancy)), options.idfLookups!.body)
    : null;
  const reasons: string[] = [`recency:${recency.band}`];
  if (titleSimilarity >= minimumTitleEvidence) reasons.push('title-evidence');
  if (hasSkillEvidence) reasons.push('skill-evidence');
  if (recency.expired) reasons.push('expired');
  if (!hasRoleOrSkillEvidence) reasons.push('insufficient-role-or-skill-evidence');
  if (combinedScore < options.minimumScore) reasons.push('below-minimum-score');

  return Object.freeze({
    regexScore,
    lexicalCosine,
    lexicalScore,
    combinedScore,
    titleSimilarity,
    skillCoverage,
    seniorityGap: selectedTrack ? seniorityGapOf(selectedTrack, vacancy.name) : null,
    specificity,
    lexicalCosineIdf,
    filtered: recency.expired || !hasRoleOrSkillEvidence || combinedScore < options.minimumScore,
    expired: recency.expired,
    reasons: Object.freeze(reasons),
  });
}
