export const digestPageSize = 10;

export interface DigestPageMeta {
  readonly page: number;
  readonly pageCount: number;
  readonly total: number;
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
}

const applyIdPattern = /^[a-z]{6}$/u;

export function normalizeApplyIdPrefix(input: string): string | null {
  const normalized = input.trim().toLowerCase();
  return /^[a-z]{1,6}$/u.test(normalized) ? normalized : null;
}

export function shortestUniqueApplyPrefixes(applyIds: readonly string[]): Readonly<Record<string, string>> {
  if (new Set(applyIds).size !== applyIds.length) throw new TypeError('Apply IDs must be unique.');
  if (applyIds.some((id) => !applyIdPattern.test(id))) throw new TypeError('Invalid apply ID.');
  const result: Record<string, string> = Object.create(null);
  for (const id of applyIds) {
    let prefix = id;
    for (let length = 1; length <= id.length; length += 1) {
      const candidate = id.slice(0, length);
      if (applyIds.filter((other) => other.startsWith(candidate)).length === 1) { prefix = candidate; break; }
    }
    result[id] = prefix;
  }
  return Object.freeze(result);
}

export function formatApplyIdWithUniquePrefix(applyId: string, scoredApplyIds: readonly string[]): string {
  if (!applyIdPattern.test(applyId) || scoredApplyIds.some((id) => !applyIdPattern.test(id))) {
    throw new TypeError('Invalid apply ID.');
  }
  const candidates = scoredApplyIds.includes(applyId) ? scoredApplyIds : [...scoredApplyIds, applyId];
  const prefix = shortestUniqueApplyPrefixes(candidates)[applyId]!;
  return `<b>${prefix}</b>${applyId.slice(prefix.length)}`;
}

export function digestPageMeta(total: number, requestedPage: number, pageSize = digestPageSize): DigestPageMeta {
  if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(requestedPage) || requestedPage < 0
    || !Number.isSafeInteger(pageSize) || pageSize < 1) throw new RangeError('Invalid digest page input.');
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, pageCount - 1);
  return Object.freeze({ page, pageCount, total, hasPrevious: page > 0, hasNext: page + 1 < pageCount });
}

export function digestPageSlice<T>(items: readonly T[], requestedPage: number, pageSize = digestPageSize): {
  readonly items: readonly T[]; readonly meta: DigestPageMeta;
} {
  const meta = digestPageMeta(items.length, requestedPage, pageSize);
  return Object.freeze({ items: Object.freeze(items.slice(meta.page * pageSize, (meta.page + 1) * pageSize)), meta });
}
