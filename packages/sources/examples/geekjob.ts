
import { type BoardEntry, type JsonLdBoard } from '@jobseeker/sources/drivers/jsonld-board';
import { createJsonLdBoardSource, examplePages, htmlText, initToolkit, russianDate, type SourceExtensionApi } from './toolkit.ts';

function absolute(base: string, href: string): string {
  return new URL(href, base).toString().split('?')[0]!;
}

export const geekjobBoard: JsonLdBoard = {
  id: 'geekjob',
  name: 'GeekJob',
  hosts: ['geekjob.ru', 'www.geekjob.ru'],
  listing(page) {
    const url = new URL('/vacancies', 'https://geekjob.ru');
    if (page > 1) url.searchParams.set('page', String(page));
    return url.toString();
  },
  entries(html, base) {
    const dates = new Map<string, string>();
    for (const match of html.matchAll(
      /<time[^>]*datetime-info[^>]*>[\s\S]*?href="\/vacancy\/([a-f0-9]{12,})"[^>]*>([^<]*)<\/a>/gi)) {
      const posted = russianDate(htmlText(match[2]!));
      if (posted) dates.set(match[1]!, posted);
    }
    const found = new Map<string, BoardEntry>();
    for (const match of html.matchAll(
      /class="truncate vacancy-name">\s*<a href="(\/vacancy\/([a-f0-9]{12,}))"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const title = htmlText(match[3]!);
      const publishedAt = dates.get(match[2]!);
      if (title) found.set(match[2]!, {
        url: absolute(base, match[1]!), title, ...publishedAt ? { publishedAt } : {},
      });
    }
    return found;
  },
  rules: ['Use Russian or established English IT role titles that occur on GeekJob.'],
};

export function geekjobSource(options: { maxPages?: number } = {}) {
  return createJsonLdBoardSource(geekjobBoard, options);
}

/** Registers this example; the loader calls it once the file sits in an extensions directory. */
export default function register(api: SourceExtensionApi): void {
  initToolkit(api);
  api.registerSourceProvider(geekjobSource({ maxPages: examplePages(api) }));
}
