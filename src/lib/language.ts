export type CvLanguage = 'ru' | 'en';

export function detectCvLanguage(text: string): CvLanguage {
  const cyrillic = text.match(/[А-Яа-яЁё]/g)?.length ?? 0;
  const latin = text.match(/[A-Za-z]/g)?.length ?? 0;
  return cyrillic >= 20 && cyrillic >= latin * 0.15 ? 'ru' : 'en';
}
