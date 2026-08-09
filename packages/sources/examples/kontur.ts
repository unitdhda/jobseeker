
import type { BoardEntry, JsonLdBoard } from '@jobseeker/sources/drivers/jsonld-board';
import { createJsonLdBoardSource, examplePages, htmlText, initToolkit, type SourceExtensionApi } from './toolkit.ts';

export const konturBoard: JsonLdBoard = {
  id: 'kontur',
  name: 'Kontur Careers',
  hosts: ['kontur.ru'],
  // The board publishes every open vacancy on one page and ignores a page parameter, so one request lists it all.
  listing: () => 'https://kontur.ru/career/vacancies',
  entries(html, base) {
    const found = new Map<string, BoardEntry>();
    for (const match of html.matchAll(
      /<a[^>]+class="vacancy"[^>]+href="(\/career\/vacancies\/(\d+))"[\s\S]*?class="vacancy__title">([\s\S]*?)<\/span>/gi)) {
      const title = htmlText(match[3]!);
      if (title) found.set(match[2]!, { url: new URL(match[1]!, base).toString(), title });
    }
    return found;
  },
  rules: ['Use Russian role titles because Контур publishes its vacancies in Russian.'],
};

/** Fresh Kontur provider over the reusable schema.org board driver. */
export function konturSource(options: { maxPages?: number } = {}) {
  return createJsonLdBoardSource(konturBoard, options);
}

/** Registers this example; the loader calls it once the file sits in an extensions directory. */
export default function register(api: SourceExtensionApi): void {
  initToolkit(api);
  api.registerSourceProvider(konturSource({ maxPages: examplePages(api) }));
}
