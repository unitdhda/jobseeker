import * as v from 'valibot';

const evidenceText = v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(300));
const label = v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(100));
const title = v.pipe(label,v.check((value) => !/\s[\/|]\s/.test(value),
  'Each title variant must contain one title in one language; put translations in separate array items.'));

export const careerTrackSchema = v.strictObject({
  name: label,
  titleVariants: v.pipe(v.array(title), v.minLength(1), v.maxLength(16)),
  coreSkills: v.pipe(v.array(label), v.maxLength(30)),
  evidence: v.pipe(v.array(evidenceText), v.minLength(1), v.maxLength(8)),
});

export const careerProfileSchema = v.strictObject({
  version: v.literal(1),
  tracks: v.pipe(v.array(careerTrackSchema), v.minLength(1), v.maxLength(10)),
});

export type CareerTrack = v.InferOutput<typeof careerTrackSchema>;
export type CareerProfile = v.InferOutput<typeof careerProfileSchema>;

export { careerProfilePlatformId } from '@jobseeker/store';

export interface StoredCareerProfile {
  cvHash: string;
  profile: CareerProfile;
}

/**
 * Splits the one mistake the career-profile agent repeats: several titles packed into a single variant, usually a
 * role and its translation joined by " / ". Only the separator the schema rejects is split, so a title that already
 * validates is never rewritten. This runs on the raw JSON after the model has failed to correct itself.
 */
const packedTitleSeparator = /\s+[\/|]\s+/;
export function normalizeCareerProfileJson(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const root = value as Record<string, unknown>;
  if (!Array.isArray(root.tracks)) return value;
  return { ...root, tracks: root.tracks.map((track) => {
    if (!track || typeof track !== 'object' || Array.isArray(track)) return track;
    const entry = track as Record<string, unknown>;
    if (!Array.isArray(entry.titleVariants)) return track;
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
    return { ...entry, titleVariants: titleVariants.slice(0, 16) };
  }) };
}

export function parseStoredCareerProfile(value: unknown, expectedCvHash: string): CareerProfile | null {
  if (!value || typeof value !== 'object') return null;
  const stored = value as Partial<StoredCareerProfile>;
  if (stored.cvHash !== expectedCvHash) return null;
  const parsed = v.safeParse(careerProfileSchema, stored.profile);
  return parsed.success ? parsed.output : null;
}

import { config } from './config.ts';
import type { Vacancy } from '@jobseeker/store';

const stop = new Set([
  'and','the','with','for','from','that','this','into','или','для','как','что','при','это','его','она','они',
  'работа','опыт','года','лет','years','year','experience','work','team','команда','задачи','требования',
]);
const seniority = new Set([
  'intern','internship','junior','middle','senior','lead','head','principal','chief','стажер','стажёр','младший',
  'средний','старший','ведущий','главный','руководитель',
]);

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

function phrasePresent(phrase: string, textTokens: string[]): boolean {
  const phraseTokens = normalizedTokens(phrase).filter((token) => !seniority.has(token));
  return phraseTokens.length > 0 && phraseTokens.every((token) => textTokens.some((candidate) => comparableToken(token, candidate)));
}

function titleSimilarity(left: string, right: string): number {
  const a = [...new Set(normalizedTokens(left).filter((token) => !seniority.has(token)))];
  const b = [...new Set(normalizedTokens(right).filter((token) => !seniority.has(token)))];
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

function trackEvidence(track: CareerTrack, vacancy: Vacancy): { role: number; skills: number; similarity: number; matchedSkills: string[] } {
  const titleVariants = track.titleVariants.flatMap((variant) => variant.split(/\s+\/\s+/).map((title) => title.trim()).filter(Boolean));
  const similarity = Math.max(0, ...titleVariants.map((variant) => titleSimilarity(variant, vacancy.name)));
  const role = Math.round(similarity ** 2 * 75);
  const vacancyTokens = normalizedTokens(`${vacancy.name}\n${vacancy.description}\n${vacancy.keySkills.join('\n')}`);
  const matchedSkills = track.coreSkills.filter((skill) => phrasePresent(skill, vacancyTokens));
  const skills = track.coreSkills.length ? Math.round(Math.min(1, matchedSkills.length / Math.min(5, track.coreSkills.length)) * 25) : 0;
  return { role, skills, similarity, matchedSkills };
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

export function vacancyRecency(vacancy: Pick<Vacancy, 'publishedAt'>, now = Date.now()): VacancyRecency {
  const published = Date.parse(vacancy.publishedAt);
  // An unparseable or future date says nothing, so it is treated as current rather than rejected on a guess.
  const days = Number.isFinite(published) ? Math.max(0, (now - published) / 86_400_000) : 0;
  const band = recencyBands.find((entry) => days < entry.withinDays) ?? recencyBands.at(-1)!;
  return { band: band.band, days: Math.floor(days), weight: band.weight,
    expired: days >= config.prefilterMaxAgeDays, label: `published ${band.label}` };
}

export interface PrefilterResult {
  regexScore: number;
  lexicalCosine: number;
  lexicalScore: number;
  combinedScore: number;
  filtered: boolean;
  reasons: string[];
}

export function vacancySemanticText(vacancy: Vacancy): string {
  return `${vacancy.name}\n${vacancy.employer}\n${vacancy.description}\n${vacancy.keySkills.join(' ')}`;
}

export function prefilterVacancy(cvText: string, vacancy: Vacancy, minimumScore: number,
  careerProfile?: CareerProfile): PrefilterResult {
  const profile = careerProfile ?? fallbackCareerProfile(cvText);
  const ranked = profile.tracks.map((track) => ({ track, ...trackEvidence(track, vacancy) }))
    .sort((left, right) => right.role + right.skills - left.role - left.skills);
  const best = ranked[0]!;
  const regexScore = Math.min(100, best.role + best.skills);
  const reasons: string[] = [`CV-derived track: ${best.track.name}`];
  if (best.similarity > 0) reasons.push(`title-variant similarity: ${best.similarity.toFixed(3)}`);
  if (best.matchedSkills.length) reasons.push(`evidenced skills: ${best.matchedSkills.slice(0, 8).join(', ')}`);

  const cleanCv = relevanceCvText(cvText);
  const lexicalCosine = cosine(lexicalEmbedding(cleanCv), lexicalEmbedding(`${vacancy.name}\n${vacancy.name}\n${vacancySemanticText(vacancy)}`));
  const lexicalScore = Math.min(100, Math.round(lexicalCosine * 300));
  const recency = vacancyRecency(vacancy);
  let combinedScore = Math.round(regexScore * 0.75 + lexicalScore * 0.25);
  if (recency.weight < 1) {
    combinedScore = Math.round(combinedScore * recency.weight);
    reasons.push(`age discount: ${recency.label}`);
  }
  if (lexicalCosine > 0) reasons.push(`lexical cosine: ${lexicalCosine.toFixed(3)}`);
  if (regexScore < 15 && combinedScore >= minimumScore) {
    combinedScore = Math.max(0, minimumScore - 1);
    reasons.push('semantic similarity lacked CV-derived role or skill evidence');
  }
  // An advert this old is treated as filled whatever it matches, so the evidence score is kept for calibration
  // but no longer decides admission.
  const filtered = recency.expired || combinedScore < minimumScore;
  if (recency.expired) reasons.push(`rejected: ${recency.label}, over the ${config.prefilterMaxAgeDays}-day limit`);
  else if (filtered) reasons.push(`combined score below ${minimumScore}`);
  return { regexScore, lexicalCosine, lexicalScore, combinedScore, filtered, reasons };
}
