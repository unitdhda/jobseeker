export function errorMessage(error: unknown): string {
  const source = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return source
    .replace(/https?:\/\/[^\s"']+/gi, '[url-redacted]')
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g, '[telegram-token-redacted]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '[authorization-redacted]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email-redacted]')
    .replace(/("?(?:access|refresh|token|secret|password|credential)"?\s*[:=]\s*)[^\s,}]+/gi, '$1[redacted]')
    .slice(0, 500);
}
