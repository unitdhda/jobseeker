import type { CareerProfile, CareerTrack } from './career-profile.ts';
import type { Vacancy } from './database.ts';

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

export interface PrefilterResult {
  regexScore: number;
  embeddingCosine: number;
  embeddingScore: number;
  semanticCosine: number | null;
  semanticScore: number | null;
  combinedScore: number;
  filtered: boolean;
  reasons: string[];
}

export function vacancySemanticText(vacancy: Vacancy): string {
  return `${vacancy.name}\n${vacancy.employer}\n${vacancy.description}\n${vacancy.keySkills.join(' ')}`;
}

export function prefilterVacancy(cvText: string, vacancy: Vacancy, minimumScore: number,
  semanticCosine: number | null = null, careerProfile?: CareerProfile): PrefilterResult {
  const profile = careerProfile ?? fallbackCareerProfile(cvText);
  const ranked = profile.tracks.map((track) => ({ track, ...trackEvidence(track, vacancy) }))
    .sort((left, right) => right.role + right.skills - left.role - left.skills);
  const best = ranked[0]!;
  const regexScore = Math.min(100, best.role + best.skills);
  const reasons: string[] = [`CV-derived track: ${best.track.name}`];
  if (best.similarity > 0) reasons.push(`title-variant similarity: ${best.similarity.toFixed(3)}`);
  if (best.matchedSkills.length) reasons.push(`evidenced skills: ${best.matchedSkills.slice(0, 8).join(', ')}`);

  const cleanCv = relevanceCvText(cvText);
  const embeddingCosine = cosine(lexicalEmbedding(cleanCv), lexicalEmbedding(`${vacancy.name}\n${vacancy.name}\n${vacancySemanticText(vacancy)}`));
  const embeddingScore = Math.min(100, Math.round(embeddingCosine * 300));
  // E5 has a high cross-occupation baseline. Only the upper similarity band contributes, and CV-derived evidence gates admission.
  const semanticScore = semanticCosine == null ? null
    : Math.max(0, Math.min(100, Math.round((semanticCosine - 0.91) / 0.07 * 100)));
  let combinedScore = semanticScore == null
    ? Math.round(regexScore * 0.75 + embeddingScore * 0.25)
    : Math.round(regexScore * 0.55 + embeddingScore * 0.15 + semanticScore * 0.30);
  if (embeddingCosine > 0) reasons.push(`lexical cosine: ${embeddingCosine.toFixed(3)}`);
  if (semanticCosine != null) reasons.push(`semantic cosine: ${semanticCosine.toFixed(3)}`);
  if (regexScore < 15 && combinedScore >= minimumScore) {
    combinedScore = Math.max(0, minimumScore - 1);
    reasons.push('semantic similarity lacked CV-derived role or skill evidence');
  }
  const filtered = combinedScore < minimumScore;
  if (filtered) reasons.push(`combined score below ${minimumScore}`);
  return { regexScore, embeddingCosine, embeddingScore, semanticCosine, semanticScore, combinedScore, filtered, reasons };
}
