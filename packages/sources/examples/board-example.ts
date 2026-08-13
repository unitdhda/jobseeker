import type { JsonLdBoard } from '@jobseeker/sources/drivers/jsonld-board';
import { assertToolkitInitialized, createJsonLdBoardSource } from './toolkit.ts';
import { boardListings, entriesOf } from './text.ts';

export interface ExampleBoardDefinition {
  readonly id: string;
  readonly name: string;
  readonly hosts: readonly string[];
  listing(page: number): string;
  readonly anchorPattern: RegExp;
  readonly rules: readonly string[];
}

export function exampleBoard(definition: ExampleBoardDefinition): JsonLdBoard {
  return Object.freeze({
    id: definition.id, name: definition.name, hosts: Object.freeze([...definition.hosts]),
    listing: definition.listing,
    entries: (html: string, base: string) => entriesOf(boardListings(html, base, definition.anchorPattern)),
    rules: Object.freeze([...definition.rules]),
  });
}

export function exampleBoardSource(definition: ExampleBoardDefinition, options: { readonly maxPages?: number } = {}) {
  assertToolkitInitialized();
  return createJsonLdBoardSource(exampleBoard(definition), options);
}

export default function register(): void {}
