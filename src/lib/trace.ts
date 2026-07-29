const enabled = process.env.TRACE_VERBOSE === 'true';
const sensitiveKey = /(?:^|_)(?:cv|cvtext|cvdocument|document|body|profile|agentoutput|output|vacancy|description|coverletter|tailoredcvtext|text|query|queries|search|searches|localqueries|rationale)(?:$|_)/i;
const secretKey = /(token|authorization|api.?key|secret|password|credential|cookie)/i;

function safe(value: unknown, key = ''): unknown {
  if (secretKey.test(key) || sensitiveKey.test(key)) return '[redacted]';
  if (value instanceof Error) return { name: value.name, message: String(value.message).slice(0, 500) };
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}… [truncated]`;
  if (Array.isArray(value)) return value.slice(0, 100).map((nested) => safe(nested));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([nestedKey, nested]) => [nestedKey, safe(nested, nestedKey)]));
  }
  return value;
}

export function trace(event: string, data: unknown = {}): void {
  if (!enabled) return;
  try {
    console.info(`[trace] ${JSON.stringify({ at: new Date().toISOString(), event, data: safe(data) })}`);
  } catch (error) {
    console.info(`[trace] ${JSON.stringify({ at: new Date().toISOString(), event, serializationError: String(error).slice(0, 200) })}`);
  }
}
