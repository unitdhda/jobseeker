import type { Locale } from '@jobseeker/store';
import { en } from './en.ts';
import { ru, type Catalogue } from './ru.ts';

export type { Catalogue } from './ru.ts';
export { resolveLocale, supportedLocale } from './locale.ts';
export { en, ru };

const catalogues: Readonly<Record<Locale, Catalogue>> = Object.freeze({ ru, en });
export function messages(locale: Locale): Catalogue { return catalogues[locale]; }
