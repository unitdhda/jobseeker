import { exampleBoardSource, type ExampleBoardDefinition } from './board-example.ts';
import { examplePages, initToolkit, type SourceExtensionApi } from './toolkit.ts';

export const konturBoard: ExampleBoardDefinition = {
  id: 'kontur', name: 'Контур', hosts: ['kontur.ru'],
  listing: () => 'https://kontur.ru/career/vacancies',
  anchorPattern: /<a\b[^>]*href=["'](?<url>\/career\/vacancies\/[^"']+)["'][^>]*>(?<title>[\s\S]*?)<\/a>/giu,
  rules: ['Use concise Russian technology role titles.'],
};
export function konturSource(options: { readonly maxPages?: number } = {}) { return exampleBoardSource(konturBoard, options); }
export default function register(api: SourceExtensionApi): void {
  initToolkit(api); api.registerSourceProvider(konturSource({ maxPages: examplePages(api) }));
}
