
import { type BoardEntry, type JsonLdBoard } from '@jobseeker/sources/drivers/jsonld-board';
import { createJsonLdBoardSource, examplePages, htmlText, initToolkit, type SourceExtensionApi } from './toolkit.ts';

function absolute(base: string, href: string): string {
  return new URL(href, base).toString().split('?')[0]!;
}

export const avitoBoard: JsonLdBoard = {
  id: 'avito',
  name: 'Avito Careers',
  hosts: ['career.avito.com'],
  listing(page) {
    const url = new URL('/vacancies/', 'https://career.avito.com');
    if (page > 1) url.searchParams.set('page', String(page));
    return url.toString();
  },
  entries(html, base) {
    const found = new Map<string, BoardEntry>();
    for (const match of html.matchAll(
      /href="(\/vacancies\/[a-z0-9_-]+\/(\d+)\/?)"\s+class="vacancies-section__item-name"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const title = htmlText(match[3]!);
      if (title) found.set(match[2]!, { url: absolute(base, match[1]!), title });
    }
    return found;
  },
  rules: ['Use Russian role titles because Avito publishes its own vacancies in Russian.'],
};

export function avitoSource(options: { maxPages?: number } = {}) {
  return createJsonLdBoardSource(avitoBoard, options);
}

/** Registers this example; the loader calls it once the file sits in an extensions directory. */
export default function register(api: SourceExtensionApi): void {
  initToolkit(api);
  api.registerSourceProvider(avitoSource({ maxPages: examplePages(api) }));
}
