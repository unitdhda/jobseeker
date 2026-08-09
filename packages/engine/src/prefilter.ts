import * as v from 'valibot';

const evidenceText = v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(300));
const label = v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(100));
const title = v.pipe(label,v.check((value) => !/\s[\/|]\s/.test(value),
  'Each title variant must contain one title in one language; put translations in separate array items.'));

/**
 * The one place these caps are written down. The schema enforces them, the repair below clips to them, and the
 * agent prompt quotes them — a track carrying thirteen evidence lines failed a user's whole profile refresh in
 * production because the prompt named no limit at all.
 */
export const careerProfileLimits = { tracks: 10, titleVariants: 16, coreSkills: 30, evidence: 8 } as const;

export const careerTrackSchema = v.strictObject({
  name: label,
  titleVariants: v.pipe(v.array(title), v.minLength(1), v.maxLength(careerProfileLimits.titleVariants)),
  coreSkills: v.pipe(v.array(label), v.maxLength(careerProfileLimits.coreSkills)),
  evidence: v.pipe(v.array(evidenceText), v.minLength(1), v.maxLength(careerProfileLimits.evidence)),
});

export const careerProfileSchema = v.strictObject({
  version: v.literal(1),
  tracks: v.pipe(v.array(careerTrackSchema), v.minLength(1), v.maxLength(careerProfileLimits.tracks)),
});

export type CareerTrack = v.InferOutput<typeof careerTrackSchema>;
export type CareerProfile = v.InferOutput<typeof careerProfileSchema>;

/** Storage key for the CV-derived career profile shared by matching and profile workflows. */
export const careerProfilePlatformId = '__career-profile-v1';

export interface StoredCareerProfile {
  cvHash: string;
  profile: CareerProfile;
}

/**
 * Repairs the mistakes the career-profile agent repeats, on the raw JSON after the model has failed to correct
 * itself. Packed titles — several titles in one variant, usually a role and its translation joined by " / " — are
 * split on exactly the separator the schema rejects, so a title that already validates is never rewritten.
 * Advisory arrays that overrun their schema caps (13 evidence lines where 8 are allowed cost a whole refresh in
 * production) are clipped: dropping excess advisory lines is strictly better than failing the profile.
 */
const packedTitleSeparator = /\s+[\/|]\s+/;
export function normalizeCareerProfileJson(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const root = value as Record<string, unknown>;
  if (!Array.isArray(root.tracks)) return value;
  return { ...root, tracks: root.tracks.slice(0, careerProfileLimits.tracks).map((track) => {
    if (!track || typeof track !== 'object' || Array.isArray(track)) return track;
    const entry = { ...(track as Record<string, unknown>) };
    const clip = (key: 'evidence' | 'coreSkills'): void => {
      const value = entry[key];
      if (Array.isArray(value) && value.length > careerProfileLimits[key]) {
        entry[key] = value.slice(0, careerProfileLimits[key]);
      }
    };
    clip('evidence');
    clip('coreSkills');
    if (!Array.isArray(entry.titleVariants)) return entry;
    const seen = new Set<string>();
    const titleVariants: unknown[] = [];
    for (const variant of entry.titleVariants) {
      if (typeof variant !== 'string') { titleVariants.push(variant); continue; }
      for (const part of variant.split(packedTitleSeparator)) {
        const title = part.trim();
        if (title.length < 2 || seen.has(title.toLowerCase())) continue;
        seen.add(title.toLowerCase());
        titleVariants.push(title);
      }
    }
    return { ...entry, titleVariants: titleVariants.slice(0, careerProfileLimits.titleVariants) };
  }) };
}

export function parseStoredCareerProfile(value: unknown, expectedCvHash: string): CareerProfile | null {
  if (!value || typeof value !== 'object') return null;
  const stored = value as Partial<StoredCareerProfile>;
  if (stored.cvHash !== expectedCvHash) return null;
  const parsed = v.safeParse(careerProfileSchema, stored.profile);
  return parsed.success ? parsed.output : null;
}

import type { VacancyContent } from './contracts.ts';
import { canonicalRoleToken } from './canon.ts';
import { identityRoleResolver, type RoleTokenResolver } from './equivalence.ts';
import { uniformIdfLookups, type IdfLookup, type IdfLookups } from './idf.ts';

const stop = new Set([
  'and','the','with','for','from','that','this','into','или','для','как','что','при','это','его','она','они',
  'работа','опыт','года','лет','years','year','experience','work','team','команда','задачи','требования',
]);
const seniority = new Set([
  'intern','internship','junior','middle','senior','lead','head','principal','chief','стажер','стажёр','младший',
  'средний','старший','ведущий','главный','руководитель',
]);

/**
 * The same words, ranked. Grade is deliberately stripped from role tokens so that a senior and a junior backend
 * developer still meet on one marker — but the LLM scorer's rubric penalizes underqualification and substantial
 * overqualification, so the difference the role gate throws away is exactly a thing the verdict turns on.
 */
const seniorityRanks = new Map<string, number>([
  ['intern', 0], ['internship', 0], ['стажер', 0], ['стажёр', 0],
  ['junior', 1], ['младший', 1],
  ['middle', 2], ['средний', 2],
  ['senior', 3], ['старший', 3],
  ['lead', 4], ['ведущий', 4],
  ['head', 5], ['principal', 5], ['chief', 5], ['главный', 5], ['руководитель', 5],
]);
const seniorityRankSpan = 5;

/** The highest grade claimed anywhere in the text, or null when it names none — which most titles do not. */
function seniorityRank(input: string): number | null {
  let rank: number | null = null;
  for (const token of input.normalize('NFKC').toLowerCase().match(/[\p{L}]{2,}/gu) ?? []) {
    const found = seniorityRanks.get(token);
    if (found != null && (rank == null || found > rank)) rank = found;
  }
  return rank;
}

function normalizedTokens(input: string): string[] {
  return input.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}+#.]{2,}/gu)
    ?.map((token) => token.replace(/^\.+|\.+$/g, ''))
    .filter((token) => token.length > 1 && !stop.has(token)) ?? [];
}

function comparableToken(left: string, right: string): boolean {
  if (left === right) return true;
  if (left.length < 5 || right.length < 5) return false;
  let common = 0;
  while (common < left.length && common < right.length && left[common] === right[common]) common++;
  return common >= 5 && common / Math.min(left.length, right.length) >= 0.72;
}

/**
 * Role/skill evidence compares canonical role tokens, not raw spellings: разработчик and developer meet on the
 * same marker, so a track the profile agent left untranslated still sees the vacancy the LLM scorer would accept.
 * The lexical embedding stays raw — markers aid the role gate, they are too coarse to shape the cosine.
 */
function roleTokens(input: string, resolve: RoleTokenResolver): string[] {
  return normalizedTokens(input).filter((token) => !seniority.has(token))
    .map((token) => resolve(canonicalRoleToken(token)));
}

function phrasePresent(phrase: string, textTokens: string[], resolve: RoleTokenResolver): boolean {
  const phraseTokens = roleTokens(phrase, resolve);
  return phraseTokens.length > 0 && phraseTokens.every((token) => textTokens.some((candidate) => comparableToken(token, candidate)));
}

function titleSimilarity(left: string, right: string, resolve: RoleTokenResolver): number {
  const a = [...new Set(roleTokens(left, resolve))];
  const b = [...new Set(roleTokens(right, resolve))];
  if (!a.length || !b.length) return 0;
  const matchedA = a.filter((token) => b.some((candidate) => comparableToken(token, candidate))).length;
  const matchedB = b.filter((token) => a.some((candidate) => comparableToken(token, candidate))).length;
  const intersection = Math.min(matchedA, matchedB);
  return intersection / (a.length + b.length - intersection);
}

function fallbackCareerProfile(cvText: string): CareerProfile {
  const titleVariants = cvText.split(/\r?\n/).map((line) => line.trim()).filter((line) => {
    const count = normalizedTokens(line).length;
    return line.length >= 3 && line.length <= 100 && count >= 1 && count <= 10;
  }).slice(0, 24);
  return { version: 1, tracks: [{
    name: 'CV-derived role evidence', titleVariants: titleVariants.length ? titleVariants : [cvText.slice(0, 100)],
    coreSkills: [], evidence: [cvText.slice(0, 300)],
  }] };
}

/**
 * How unusual the words that matched were, in [0, 1].
 *
 * The companion to `titleSimilarity`, and the reason it is a separate number rather than a weighting of it:
 * weighting a *ratio* by rarity leaves a full match at 1.0 however common its words are, which was measured and
 * changed nothing (the same 1,200-row pile, the same 40% conversion). What separates "Designer" meeting
 * "Designer" from "Communication Designer" meeting "Communication Designer" is the absolute rarity of what
 * matched, so that is what this reports.
 *
 * Normalized by `unknownIdf`, the value a token seen once carries, so the scale does not move when the corpus
 * grows.
 */
function matchedSpecificity(variant: string, vacancyName: string, resolve: RoleTokenResolver,
  idf: IdfLookup): number {
  const track = [...new Set(roleTokens(variant, resolve))];
  const advert = [...new Set(roleTokens(vacancyName, resolve))];
  const matched = advert.filter((token) => track.some((candidate) => comparableToken(token, candidate)));
  if (!matched.length || !idf.unknownIdf) return 0;
  const mean = matched.reduce((sum, token) => sum + idf.of(token), 0) / matched.length;
  return Math.max(0, Math.min(1, mean / idf.unknownIdf));
}

function trackEvidence(track: CareerTrack, vacancy: VacancyContent,
  resolve: RoleTokenResolver, idf: IdfLookup): { role: number; skills: number; similarity: number;
    matchedSkills: string[]; skillCoverage: number; specificity: number } {
  const titleVariants = track.titleVariants.flatMap((variant) => variant.split(/\s+\/\s+/).map((title) => title.trim()).filter(Boolean));
  const similarity = Math.max(0, ...titleVariants.map((variant) => titleSimilarity(variant, vacancy.name, resolve)));
  const specificity = Math.max(0, ...titleVariants.map((variant) =>
    matchedSpecificity(variant, vacancy.name, resolve, idf)));
  const role = Math.round(similarity ** 2 * 75);
  const vacancyTokens = roleTokens(`${vacancy.name}\n${vacancy.description}\n${vacancy.keySkills.join('\n')}`, resolve);
  const matchedSkills = track.coreSkills.filter((skill) => phrasePresent(skill, vacancyTokens, resolve));
  // Scale-free on purpose: a track listing three skills and one listing thirty are both reported as the share of
  // the evidence that landed, so the number means the same thing across profiles and stays comparable over time.
  const skillCoverage = track.coreSkills.length
    ? Math.min(1, matchedSkills.length / Math.min(5, track.coreSkills.length)) : 0;
  const skills = Math.round(skillCoverage * 25);
  return { role, skills, similarity, matchedSkills, skillCoverage, specificity };
}

function lexicalEmbedding(input: string): Map<string, number> {
  const tokens = normalizedTokens(input);
  const counts = new Map<string, number>();
  const add = (feature: string, weight: number) => counts.set(feature, (counts.get(feature) ?? 0) + weight);
  for (let index = 0; index < tokens.length; index++) {
    add(`w:${tokens[index]}`, 1);
    if (index + 1 < tokens.length) add(`b:${tokens[index]}_${tokens[index + 1]}`, 1.4);
    const compact = tokens[index].replace(/[^\p{L}\p{N}]/gu, '');
    if (compact.length >= 5) for (let offset = 0; offset <= compact.length - 3; offset++) add(`c:${compact.slice(offset, offset + 3)}`, 0.12);
  }
  for (const [feature, count] of counts) counts.set(feature, Math.log1p(count));
  return counts;
}

/**
 * Plain words weighted by how unusual they are — no bigrams, no character trigrams.
 *
 * `lexicalEmbedding` above is largely a length meter. Measured across the production corpus its cosine rises
 * monotonically with advert length (0.078 under a thousand characters to 0.127 over six thousand) while the
 * share of adverts worth delivering *falls* over the same range (35% to 13%), so it pushes verbose adverts up
 * the queue. Rarity weighting removes almost all of it: rank correlation with advert length drops from 0.178 to
 * 0.017, and correlation with the LLM's verdict rises from 0.292 to 0.402.
 *
 * The character trigrams go because they measured spelling, not meaning, and could never cross ru/en — which
 * the role-token vocabulary already handles properly.
 */
function rarityEmbedding(input: string, idf: IdfLookup): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of normalizedTokens(input)) counts.set(token, (counts.get(token) ?? 0) + 1);
  const weighted = new Map<string, number>();
  for (const [token, count] of counts) weighted.set(token, Math.log1p(count) * idf.of(token));
  return weighted;
}

function cosine(left: Map<string, number>, right: Map<string, number>): number {
  let dot = 0; let leftNorm = 0; let rightNorm = 0;
  for (const value of left.values()) leftNorm += value * value;
  for (const value of right.values()) rightNorm += value * value;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  for (const [feature, value] of small) dot += value * (large.get(feature) ?? 0);
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

function relevanceCvText(input: string): string {
  return input.split(/\r?\n/).filter((line) => !/\b(?:contacts?|email|e-mail|phone|telegram|whatsapp)\b|контакт|почт|телефон/i.test(line))
    .join('\n').replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, ' ').replace(/https?:\/\/\S+/gi, ' ')
    .replace(/(?:\+?\d[\s().-]*){7,}/g, ' ');
}

export type RecencyBand = 'today' | 'week' | 'fortnight' | 'month' | 'stale';
/**
 * Age bands rather than a raw timestamp: a day's difference does not change how worth reading a vacancy is, but
 * the difference between this week and last month does. The weight discounts an ageing match without letting
 * recency outrank fit — a strong match a fortnight old still beats a weak one posted today. Past
 * `PREFILTER_MAX_AGE_DAYS` the gradient stops and the vacancy is rejected outright.
 *
 * `publishedAt` is the advert's own date, taken from the source by each adapter, never the time we first saw it.
 */
const recencyBands: readonly { band: RecencyBand; withinDays: number; weight: number; label: string }[] = [
  { band: 'today', withinDays: 1, weight: 1, label: 'today' },
  { band: 'week', withinDays: 7, weight: 1, label: '1-7 days ago' },
  { band: 'fortnight', withinDays: 14, weight: 0.92, label: '8-14 days ago' },
  { band: 'month', withinDays: 30, weight: 0.8, label: '15-30 days ago' },
  { band: 'stale', withinDays: Number.POSITIVE_INFINITY, weight: 0.6, label: 'over 30 days ago' },
];

export interface VacancyRecency { band: RecencyBand; days: number; weight: number; expired: boolean; label: string }

export function vacancyRecency(vacancy: Pick<VacancyContent, 'publishedAt'>, now = Date.now(), maxAgeDays = 30): VacancyRecency {
  const published = Date.parse(vacancy.publishedAt);
  // An unparseable or future date says nothing, so it is treated as current rather than rejected on a guess.
  const days = Number.isFinite(published) ? Math.max(0, (now - published) / 86_400_000) : 0;
  const band = recencyBands.find((entry) => days < entry.withinDays) ?? recencyBands.at(-1)!;
  return { band: band.band, days: Math.floor(days), weight: band.weight,
    expired: days >= maxAgeDays, label: `published ${band.label}` };
}

export interface PrefilterResult {
  regexScore: number;
  lexicalCosine: number;
  lexicalScore: number;
  combinedScore: number;
  /**
   * The two signals `regexScore` collapses into one number, kept separately because the calibration can only
   * learn from what is frozen at match time. Both are 0..1 and independent of how long the CV's skill list is.
   */
  titleSimilarity: number;
  skillCoverage: number;
  /**
   * How far the advert's grade sits from the CV's, as (vacancy - cv) / 5 in [-1, 1]: positive means the advert
   * asks for more seniority than the CV claims, negative means it asks for less. Null when either side names no
   * grade at all, which is the common case and must not be confused with "the grades match".
   *
   * Recorded only. Nothing weighs it yet: like title similarity and skill coverage before it, it cannot earn a
   * coefficient until enough matches carry it, and folding an unvalidated guess into the score would change
   * admission on a hunch.
   */
  seniorityGap: number | null;
  /**
   * The rarity-aware pair, both 0..1, and **null when no vocabulary was available** rather than 0.
   *
   * Null and zero are different claims: zero says the words that matched were as common as words get, null says
   * nobody looked. Conflating them is not hypothetical — imputing 0 for an absent feature was measured to drive
   * its fitted coefficient from +3.01 to -0.24, inverting the signal, so the distinction is carried all the way
   * into the calibration.
   */
  specificity: number | null;
  lexicalCosineIdf: number | null;
  filtered: boolean;
  /** True when the advert's age alone rejected it; no evidence score can admit an expired advert. */
  expired: boolean;
  reasons: string[];
}

export function vacancySemanticText(vacancy: VacancyContent): string {
  return `${vacancy.name}\n${vacancy.employer}\n${vacancy.description}\n${vacancy.keySkills.join(' ')}`;
}

/**
 * The raw evidence score, derived from frozen evidence alone.
 *
 * Extracted so the scoring queue can recompute it from a stored `matches` row without the CV that produced it.
 * `prefilterVacancy` below is the only other caller, which is the point: the ordering fallback and the score
 * written at match time cannot drift apart, because there is one definition of the arithmetic.
 */
export function combinedEvidenceScore(regexScore: number, lexicalCosine: number, recencyWeight: number): number {
  const lexicalScore = Math.min(100, Math.round(lexicalCosine * 300));
  const combined = Math.round(regexScore * 0.75 + lexicalScore * 0.25);
  return Math.max(0, recencyWeight < 1 ? Math.round(combined * recencyWeight) : combined);
}

export function prefilterVacancy(cvText: string, vacancy: VacancyContent, minimumScore: number,
  careerProfile?: CareerProfile, maxAgeDays = 30, resolve: RoleTokenResolver = identityRoleResolver,
  idf: IdfLookups = uniformIdfLookups): PrefilterResult {
  const profile = careerProfile ?? fallbackCareerProfile(cvText);
  const ranked = profile.tracks.map((track) => ({ track, ...trackEvidence(track, vacancy, resolve, idf.title) }))
    .sort((left, right) => right.role + right.skills - left.role - left.skills);
  const best = ranked[0]!;
  const regexScore = Math.min(100, best.role + best.skills);
  const reasons: string[] = [`CV-derived track: ${best.track.name}`];
  if (best.similarity > 0) reasons.push(`title-variant similarity: ${best.similarity.toFixed(3)}`);
  if (best.matchedSkills.length) reasons.push(`evidenced skills: ${best.matchedSkills.slice(0, 8).join(', ')}`);

  const cvRank = seniorityRank(best.track.titleVariants.join('\n'));
  const vacancyRank = seniorityRank(vacancy.name);
  const seniorityGap = cvRank == null || vacancyRank == null ? null
    : Math.max(-1, Math.min(1, (vacancyRank - cvRank) / seniorityRankSpan));
  if (seniorityGap != null && seniorityGap !== 0) {
    reasons.push(`seniority gap: ${seniorityGap > 0 ? 'advert asks above' : 'advert asks below'} the CV's grade`);
  }

  const cleanCv = relevanceCvText(cvText);
  const weightedVacancyText = `${vacancy.name}\n${vacancy.name}\n${vacancySemanticText(vacancy)}`;
  const lexicalCosine = cosine(lexicalEmbedding(cleanCv), lexicalEmbedding(weightedVacancyText));
  // Each rarity feature answers for its own vocabulary. They are rebuilt together in practice, but they are
  // separate signals in separate columns, and one being unavailable is no reason to discard the other.
  const specificity = idf.title.documents > 0 ? best.specificity : null;
  const lexicalCosineIdf = idf.body.documents > 0
    ? cosine(rarityEmbedding(cleanCv, idf.body), rarityEmbedding(weightedVacancyText, idf.body)) : null;
  const lexicalScore = Math.min(100, Math.round(lexicalCosine * 300));
  const recency = vacancyRecency(vacancy, Date.now(), maxAgeDays);
  let combinedScore = combinedEvidenceScore(regexScore, lexicalCosine, recency.weight);
  if (recency.weight < 1) reasons.push(`age discount: ${recency.label}`);
  if (lexicalCosine > 0) reasons.push(`lexical cosine: ${lexicalCosine.toFixed(3)}`);
  if (regexScore < 15 && combinedScore >= minimumScore) {
    combinedScore = Math.max(0, minimumScore - 1);
    reasons.push('semantic similarity lacked CV-derived role or skill evidence');
  }
  // An advert this old is treated as filled whatever it matches, so the evidence score is kept for calibration
  // but no longer decides admission.
  const filtered = recency.expired || combinedScore < minimumScore;
  if (recency.expired) reasons.push(`rejected: ${recency.label}, over the ${maxAgeDays}-day limit`);
  else if (filtered) reasons.push(`combined score below ${minimumScore}`);
  return { regexScore, lexicalCosine, lexicalScore, combinedScore,
    titleSimilarity: best.similarity, skillCoverage: best.skillCoverage, seniorityGap,
    specificity, lexicalCosineIdf,
    filtered, expired: recency.expired, reasons };
}
