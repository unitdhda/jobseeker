import { assertPublicAddress, sourceUrl } from './url-security.ts';

export const maximumSourceBytes = 5 * 1024 * 1024;
const maximumRedirects = 3;

export async function readResponseBytes(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error(`Response exceeds ${maximumBytes} bytes`);
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel('response too large');
        throw new Error(`Response exceeds ${maximumBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

export async function fetchSourceResponse(source: string, input: string, init: RequestInit = {}): Promise<Response> {
  let current = sourceUrl(source, input);
  for (let redirects = 0; ; redirects++) {
    await assertPublicAddress(current);
    const response = await fetch(current, { ...init, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (redirects >= maximumRedirects) { await response.body?.cancel(); throw new Error('Too many source redirects'); }
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new Error('Source redirect has no location');
    const next = sourceUrl(source, new URL(location, current).toString());
    if (next.origin !== current.origin) throw new Error('Cross-origin source redirect was blocked');
    current = next;
  }
}

export async function fetchSourceText(source: string, input: string, init: RequestInit = {},
  maximumBytes = maximumSourceBytes): Promise<{ text: string; url: string; contentType: string }> {
  const response = await fetchSourceResponse(source, input, init);
  if (!response.ok) throw new Error(`Source request failed (${response.status})`);
  const contentType = response.headers.get('content-type') ?? '';
  const bytes = await readResponseBytes(response, maximumBytes);
  return { text: new TextDecoder().decode(bytes), url: response.url, contentType };
}

export async function fetchSourceJson(source: string, input: string, init: RequestInit = {},
  maximumBytes = maximumSourceBytes): Promise<unknown> {
  const result = await fetchSourceText(source, input, init, maximumBytes);
  if (result.contentType && !/(?:application|text)\/(?:[a-z0-9.+-]*\+)?json\b/i.test(result.contentType)) {
    throw new Error('Source returned an unexpected content type');
  }
  return JSON.parse(result.text);
}
