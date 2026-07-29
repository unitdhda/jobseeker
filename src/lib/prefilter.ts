import type { Vacancy } from './database.ts';

interface SkillPattern { name: string; pattern: RegExp; weight?: number }

const skills: SkillPattern[] = [
  { name: 'TypeScript', pattern: /\btypescript\b|\bts\b/i, weight: 9 },
  { name: 'JavaScript', pattern: /\bjavascript\b|\bjs\b/i, weight: 7 },
  { name: 'React', pattern: /\breact(?:\.js)?\b/i, weight: 10 },
  { name: 'Next.js', pattern: /\bnext(?:\.js|js)?\b/i, weight: 9 },
  { name: 'Node.js', pattern: /\bnode(?:\.js|js)?\b/i, weight: 9 },
  { name: 'Express', pattern: /\bexpress(?:\.js)?\b/i, weight: 7 },
  { name: 'PostgreSQL', pattern: /\bpostgres(?:ql)?\b/i, weight: 7 },
  { name: 'Redis', pattern: /\bredis\b/i, weight: 6 },
  { name: 'Python', pattern: /\bpython\b/i, weight: 8 },
  { name: 'Rust', pattern: /\brust\b/i, weight: 7 },
  { name: 'D3.js', pattern: /\bd3(?:\.js)?\b/i, weight: 6 },
  { name: 'Three.js', pattern: /\bthree(?:\.js)?\b/i, weight: 6 },
  { name: 'LLM', pattern: /\bllms?\b|large language model|языков(?:ая|ые) модел/i, weight: 8 },
  { name: 'RAG', pattern: /\brag\b|retrieval.augmented/i, weight: 7 },
  { name: 'Whisper', pattern: /\bwhisper\b/i, weight: 5 },
  { name: 'Git', pattern: /\bgit\b/i, weight: 4 },
  { name: 'Docker', pattern: /\bdocker\b/i, weight: 5 },
  { name: 'REST API', pattern: /\brest(?:ful)?\b|\bapi\b/i, weight: 5 },
  { name: 'Telegram', pattern: /\btelegram\b|\btelegraf\b/i, weight: 4 },
];

const tracks = {
  frontend: /front[ -]?end|фронт[ -]?энд|фронтенд|react|next\.?(?:js)?|web[- ]?интерфейс/i,
  backend: /back[ -]?end|бэк[ -]?энд|бэкенд|backend|node\.?(?:js)?|серверн(?:ая|ый|ое) разработ/i,
  ai: /\bai\b|\bml\b|machine learning|artificial intelligence|искусственн(?:ый|ого) интеллект|машинн(?:ое|ого) обуч|\bllm\b|\brag\b|нейросет/i,
};

const softwareTitle = /разработчик|developer|engineer|инженер (?:по )?(?:данным|машинному|программ)|programmer|программист|frontend|backend|fullstack|full-stack|devops|data scientist|аналитик данных|системный аналитик|architect|архитектор|\bai\b|\bml\b/i;
const aliases: Array<[RegExp, string]> = [
  [/фронт(?:енд|энд)|фронтенд/giu, ' frontend '], [/бэк(?:енд|энд)|бэкенд/giu, ' backend '],
  [/фуллст[еэ]к|full-stack/giu, ' fullstack '], [/разработ(?:чик|ка|ки|ку|чиков)/giu, ' developer '],
  [/программист(?:а|ы|ов)?/giu, ' developer '], [/искусственн\w* интеллект\w*/giu, ' ai '],
  [/машинн\w* обучен\w*/giu, ' machine learning '], [/удал[её]нн\w*/giu, ' remote '],
  [/постгрес(?:ql)?/giu, ' postgresql '], [/тайпскрипт/giu, ' typescript '], [/джаваскрипт/giu, ' javascript '],
];
const stop = new Set(['and','the','with','for','from','that','this','или','для','как','что','при','это','его','она','они','работа','опыт','года','лет','years','year','experience','work','team','команда','задачи','требования']);

function normalizedTokens(input: string): string[] {
  let value = input.toLowerCase();
  for (const [pattern, replacement] of aliases) value = value.replace(pattern, replacement);
  return value.match(/[\p{L}\p{N}+#.]{2,}/gu)?.map((token) => token.replace(/^\.+|\.+$/g, ''))
    .filter((token) => token.length > 1 && !stop.has(token)) ?? [];
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
  semanticCosine: number | null = null): PrefilterResult {
  const vacancyText = vacancySemanticText(vacancy);
  const cvTracks = Object.entries(tracks).filter(([, pattern]) => pattern.test(cvText)).map(([track]) => track);
  const vacancyTracks = Object.entries(tracks).filter(([, pattern]) => pattern.test(vacancyText)).map(([track]) => track);
  const overlap = skills.filter((skill) => skill.pattern.test(cvText) && skill.pattern.test(vacancyText));
  const reasons: string[] = [];
  let regexScore = 8;
  if (softwareTitle.test(vacancy.name)) { regexScore += 24; reasons.push('software-role title'); }
  const trackOverlap = vacancyTracks.filter((track) => cvTracks.includes(track));
  if (trackOverlap.length) { regexScore += 16; reasons.push(`track overlap: ${trackOverlap.join(', ')}`); }
  const skillPoints = Math.min(46, overlap.reduce((sum, skill) => sum + (skill.weight ?? 5), 0));
  regexScore += skillPoints;
  if (overlap.length) reasons.push(`skills: ${overlap.map((skill) => skill.name).join(', ')}`);
  regexScore = Math.min(100, regexScore);

  const cvEmbedding = lexicalEmbedding(cvText);
  const titleWeightedVacancy = `${vacancy.name}\n${vacancy.name}\n${vacancy.name}\n${vacancyText}`;
  const embeddingCosine = cosine(cvEmbedding, lexicalEmbedding(titleWeightedVacancy));
  const embeddingScore = Math.min(100, Math.round(embeddingCosine * 300));
  // Multilingual E5 cosine values have a high baseline; map roughly 0.82→0 and 0.95→100.
  const semanticScore = semanticCosine == null ? null
    : Math.max(0, Math.min(100, Math.round((semanticCosine - 0.82) / 0.13 * 100)));
  const combinedScore = semanticScore == null
    ? Math.round(regexScore * 0.65 + embeddingScore * 0.35)
    : Math.round(regexScore * 0.45 + embeddingScore * 0.15 + semanticScore * 0.40);
  if (embeddingCosine > 0) reasons.push(`lexical embedding cosine: ${embeddingCosine.toFixed(3)}`);
  if (semanticCosine != null) reasons.push(`semantic embedding cosine: ${semanticCosine.toFixed(3)}`);
  const filtered = combinedScore < minimumScore;
  if (combinedScore < minimumScore) reasons.push(`combined score below ${minimumScore}`);
  return { regexScore, embeddingCosine, embeddingScore, semanticCosine, semanticScore, combinedScore, filtered, reasons };
}
