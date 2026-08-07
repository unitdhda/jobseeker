/**
 * Canonicalization shared by demand compilation, unit identity, and the migration: everything that must agree on
 * "these two searches mean the same thing" imports it from here, byte for byte.
 */
/**
 * Role vocabulary that makes an English and a Russian spelling of the same job cluster together. This is a recall
 * heuristic on top of token overlap, not a translator: a term only ever collapses onto a shared marker, so an
 * unlisted word simply keeps itself and clusters by literal overlap.
 */
const roleMarkers: Record<string, string> = {
  разработчик: 'dev', разработка: 'dev', разработке: 'dev', developer: 'dev', development: 'dev',
  программист: 'dev', engineer: 'dev', engineering: 'dev', инженер: 'dev', инженерия: 'dev',
  бэкенд: 'backend', бекенд: 'backend', backend: 'backend', серверный: 'backend',
  фронтенд: 'frontend', фронтэнд: 'frontend', frontend: 'frontend',
  фулстек: 'fullstack', фулстак: 'fullstack', фуллстек: 'fullstack', fullstack: 'fullstack', stack: 'fullstack',
  машинного: 'ml', обучения: 'ml', обучению: 'ml', machine: 'ml', learning: 'ml', ml: 'ml', мл: 'ml',
  компьютерного: 'vision', зрения: 'vision', computer: 'vision', vision: 'vision', cv: 'vision',
  искусственного: 'ai', интеллекта: 'ai', ai: 'ai', ии: 'ai',
  данных: 'data', data: 'data', дата: 'data', сайентист: 'scientist', scientist: 'scientist',
  аналитик: 'analyst', analyst: 'analyst', аналитике: 'analyst', анализу: 'analysis', analysis: 'analysis',
  исследователь: 'research', исследований: 'research', research: 'research', researcher: 'research',
  научный: 'research', сотрудник: 'research',
  руководитель: 'lead', тимлид: 'lead', лид: 'lead', lead: 'lead', team: 'lead', команды: 'lead', группы: 'lead',
  дизайнер: 'designer', designer: 'designer', design: 'designer', дизайна: 'designer',
  директор: 'director', director: 'director', арт: 'art', art: 'art',
  продуктовый: 'product', product: 'product', моушн: 'motion', motion: 'motion',
  коммуникационный: 'communication', communication: 'communication',
  преподаватель: 'teacher', наставник: 'teacher', mentor: 'teacher', teacher: 'teacher',
  веб: 'web', web: 'web', мобильный: 'mobile', mobile: 'mobile',
  приложений: 'app', приложения: 'app', application: 'app', applications: 'app', app: 'app',
};

/**
 * Grade words are dropped before clustering: a senior and a middle listing of the same role come from the same
 * search page, so keeping them apart would fetch that page twice.
 */
const gradeWords = new Set([
  'junior', 'middle', 'senior', 'principal', 'chief', 'head', 'staff', 'intern', 'младший', 'средний', 'старший',
  'ведущий', 'главный', 'стажер', 'стажёр',
]);
const noiseWords = new Set(['or', 'and', 'и', 'или', 'the', 'a', 'по', 'для', 'с', 'в', 'на', 'специалист']);

/**
 * The shared role vocabulary, exposed token-by-token so the prefilter's title and skill evidence can compare a
 * Russian CV with an English advert (and vice versa) through the same markers unit clustering already trusts.
 * An unlisted token keeps itself — this never widens a match, it only lets equivalent role words meet.
 */
export function canonicalRoleToken(token: string): string {
  return roleMarkers[token] ?? token;
}

export function searchTokens(text: string): Set<string> {
  const tokens = text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}+#.]{2,}/gu) ?? [];
  return new Set(tokens
    .map((token) => token.replace(/^[.]+|[.]+$/g, ''))
    .filter((token) => token.length > 1 && !gradeWords.has(token) && !noiseWords.has(token))
    .map((token) => roleMarkers[token] ?? token));
}
