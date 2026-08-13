import { exampleBoardSource, type ExampleBoardDefinition } from './board-example.ts';
import { examplePages, initToolkit, type SourceExtensionApi } from './toolkit.ts';

export const geekjobBoard: ExampleBoardDefinition = {
  id: 'geekjob', name: 'GeekJob', hosts: ['geekjob.ru'],
  listing: (page) => `https://geekjob.ru/vacancies?page=${page}`,
  anchorPattern: /<a\b[^>]*href=["'](?<url>\/vacancy\/[^"']+)["'][^>]*>(?<title>[\s\S]*?)<\/a>/giu,
  rules: ['Use Russian or English technology role titles.'],
};
export function geekjobSource(options: { readonly maxPages?: number } = {}) { return exampleBoardSource(geekjobBoard, options); }
export default function register(api: SourceExtensionApi): void {
  initToolkit(api); api.registerSourceProvider(geekjobSource({ maxPages: examplePages(api) }));
}
