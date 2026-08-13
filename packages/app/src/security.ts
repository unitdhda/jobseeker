const sensitiveKey = /(?:authorization|cookie|credential|password|passwd|secret|token|api[-_]?key|database[-_]?url|cv|document|body|description|query|prompt|rationale|letter|content)/iu;
const urlPattern = /\bhttps?:\/\/[^\s<>'"]+/giu;
const databaseUrlPattern = /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s<>'"]+/giu;
const telegramTokenPattern = /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/gu;
const authPattern = /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_:.-]+/giu;
const emailPattern = /\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/gu;
const assignmentPattern = /\b(password|passwd|secret|token|api[_-]?key|authorization)=([^\s&]+)/giu;

export interface RedactionLimits { readonly depth?: number; readonly keys?: number; readonly array?: number; readonly string?: number }
function redactString(value: string, maximum: number): string {
  return value
    .replace(databaseUrlPattern, '[REDACTED_DATABASE_URL]')
    .replace(telegramTokenPattern, '[REDACTED_TELEGRAM_TOKEN]')
    .replace(authPattern, '[REDACTED_AUTHORIZATION]')
    .replace(emailPattern, '[REDACTED_EMAIL]')
    .replace(assignmentPattern, '$1=[REDACTED]')
    .replace(urlPattern, (raw) => {
      try { const url = new URL(raw); return `${url.origin}${url.pathname}`; } catch { return '[REDACTED_URL]'; }
    })
    .slice(0, maximum);
}

export function redactTrace(value: unknown, limits: RedactionLimits = {}): unknown {
  const maximumDepth = limits.depth ?? 5; const maximumKeys = limits.keys ?? 40;
  const maximumArray = limits.array ?? 20; const maximumString = limits.string ?? 500;
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number, key?: string): unknown => {
    if (key && sensitiveKey.test(key)) return '[REDACTED]';
    if (typeof item === 'string') return redactString(item, maximumString);
    if (typeof item === 'number') return Number.isFinite(item) ? item : '[NON_FINITE]';
    if (typeof item === 'boolean' || item === null) return item;
    if (typeof item === 'bigint') return item.toString();
    if (item instanceof Date) return Number.isFinite(item.getTime()) ? item.toISOString() : '[INVALID_DATE]';
    if (item instanceof URL) return `${item.origin}${item.pathname}`;
    if (typeof item !== 'object') return `[${typeof item}]`;
    if (depth >= maximumDepth) return '[MAX_DEPTH]';
    if (ancestors.has(item)) return '[CIRCULAR]';
    ancestors.add(item);
    try {
      if (Array.isArray(item)) return item.slice(0, maximumArray).map((entry) => visit(entry, depth + 1));
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return '[OBJECT]';
      const output: Record<string, unknown> = {};
      for (const [entryKey, entry] of Object.entries(item as Record<string, unknown>).slice(0, maximumKeys)) {
        output[entryKey] = visit(entry, depth + 1, entryKey);
      }
      return output;
    } finally { ancestors.delete(item); }
  };
  return visit(value, 0);
}

export function safeErrorMessage(error: unknown, maximum = 500): string {
  if (!Number.isSafeInteger(maximum) || maximum < 20 || maximum > 2_000) throw new RangeError('Invalid error summary limit.');
  const name = error instanceof Error ? error.name : 'Error';
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown failure.';
  return `${name}: ${redactString(raw.replace(/\s+/gu, ' '), Math.max(0, maximum - name.length - 2))}`.slice(0, maximum);
}
