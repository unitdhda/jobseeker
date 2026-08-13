import { exampleBoardSource, type ExampleBoardDefinition } from './board-example.ts';
import { examplePages, initToolkit, type SourceExtensionApi } from './toolkit.ts';

export const avitoBoard: ExampleBoardDefinition = {
  id: 'avito', name: 'Avito Работа', hosts: ['www.avito.ru'],
  listing: (page) => `https://www.avito.ru/rossiya/vakansii?p=${page}`,
  anchorPattern: /<a\b[^>]*href=["'](?<url>\/[^"']*\/vakansii\/[^"']+)["'][^>]*>(?<title>[\s\S]*?)<\/a>/giu,
  rules: ['Use concise Russian role titles.'],
};
export function avitoSource(options: { readonly maxPages?: number } = {}) { return exampleBoardSource(avitoBoard, options); }
export default function register(api: SourceExtensionApi): void {
  initToolkit(api); api.registerSourceProvider(avitoSource({ maxPages: examplePages(api) }));
}
