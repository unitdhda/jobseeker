import { exampleBoardSource, type ExampleBoardDefinition } from './board-example.ts';
import { examplePages, initToolkit, type SourceExtensionApi } from './toolkit.ts';

export const habrBoard: ExampleBoardDefinition = {
  id: 'habr', name: 'Habr Career', hosts: ['career.habr.com'],
  listing: (page) => `https://career.habr.com/vacancies?page=${page}`,
  anchorPattern: /<a\b[^>]*href=["'](?<url>\/vacancies\/\d+)["'][^>]*>(?<title>[\s\S]*?)<\/a>(?:[\s\S]{0,500}?<time[^>]*>(?<date>[\s\S]*?)<\/time>)?/giu,
  rules: ['Use Russian or English technology role titles.'],
};
export function habrSource(options: { readonly maxPages?: number } = {}) { return exampleBoardSource(habrBoard, options); }
export default function register(api: SourceExtensionApi): void {
  initToolkit(api); api.registerSourceProvider(habrSource({ maxPages: examplePages(api) }));
}
