import { asObject, htmlText, jobPostings, plainText, russianDate } from './toolkit.ts';

export interface BoardListing { readonly sourceId: string; readonly url: string; readonly title: string; readonly publishedAt?: string }

function sourceIdFromUrl(value: string): string | null {
  try {
    const url = new URL(value, 'https://placeholder.invalid');
    const segment = url.pathname.split('/').filter(Boolean).at(-1);
    return segment?.trim() || null;
  } catch { return null; }
}

/** Extracts real title/date from JSON-LD listing blocks before falling back to vacancy anchors. */
export function boardListings(html: string, base: string, anchorPattern: RegExp): readonly BoardListing[] {
  const output = new Map<string, BoardListing>();
  for (const posting of jobPostings(html)) {
    const url = plainText(posting.url); const title = plainText(posting.title); const sourceId = sourceIdFromUrl(url);
    if (!url || !title || !sourceId) continue;
    const date = plainText(posting.datePosted);
    output.set(sourceId, { sourceId, url: new URL(url, base).href, title, ...(date ? { publishedAt: date } : {}) });
  }
  for (const match of html.matchAll(anchorPattern)) {
    const attributes = match.groups ?? {};
    const url = attributes.url; const title = htmlText(attributes.title ?? '');
    const sourceId = sourceIdFromUrl(url ?? '');
    if (!url || !title || !sourceId || output.has(sourceId)) continue;
    const printed = htmlText(attributes.date ?? ''); const date = printed ? russianDate(printed) : null;
    output.set(sourceId, { sourceId, url: new URL(url, base).href, title, ...(date ? { publishedAt: date } : {}) });
  }
  return Object.freeze([...output.values()]);
}

export function entriesOf(listings: readonly BoardListing[]): ReadonlyMap<string, Omit<BoardListing, 'sourceId'>> {
  return new Map(listings.map(({ sourceId, ...entry }) => [sourceId, entry]));
}

export function jsonLdEntries(html: string, base: string): ReadonlyMap<string, Omit<BoardListing, 'sourceId'>> {
  return entriesOf(boardListings(html, base, /(?!) /gu));
}

export function objectArray(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asObject).filter((item): item is Record<string, unknown> => item !== null) : [];
}

export default function register(): void {}
