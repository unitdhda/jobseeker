import { exampleBoardSource, type ExampleBoardDefinition } from './board-example.ts';
import { examplePages, initToolkit, type SourceExtensionApi } from './toolkit.ts';

export const rabotaBoard: ExampleBoardDefinition = {
  id: 'rabota', name: 'Работа.ру', hosts: ['www.rabota.ru'],
  listing: (page) => `https://www.rabota.ru/vacancy/?page=${page}`,
  anchorPattern: /<a\b[^>]*href=["'](?<url>\/vacancy\/[^"']+)["'][^>]*>(?<title>[\s\S]*?)<\/a>/giu,
  rules: ['Use concise Russian role titles.'],
};
export function rabotaSource(options: { readonly maxPages?: number } = {}) { return exampleBoardSource(rabotaBoard, options); }
export default function register(api: SourceExtensionApi): void {
  initToolkit(api); api.registerSourceProvider(rabotaSource({ maxPages: examplePages(api) }));
}
