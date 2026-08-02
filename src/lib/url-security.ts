import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

const sourceHosts: Record<string, ReadonlySet<string>> = {
  hh: new Set(['hh.ru', 'www.hh.ru']),
  habr: new Set(['career.habr.com']),
  rabota: new Set(['rabota.ru', 'www.rabota.ru']),
};

function privateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
}

function privateIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0];
  return normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd')
    || /^fe[89ab]/.test(normalized) || normalized.startsWith('ff')
    || normalized.startsWith('::ffff:127.') || normalized.startsWith('::ffff:10.')
    || normalized.startsWith('::ffff:192.168.');
}

export function sourceUrl(source: string, input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error(`Invalid ${source} URL`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new Error(`Unsafe ${source} URL`);
  }
  const allowed = sourceHosts[source];
  if (!allowed?.has(url.hostname.toLowerCase())) throw new Error(`Unexpected ${source} URL host`);
  return url;
}

export function safeVacancyUrl(source: string, input: string): string {
  return sourceUrl(source, input).toString();
}

export async function assertPublicAddress(url: URL): Promise<void> {
  if (isIP(url.hostname)) throw new Error('Source URL must use an approved DNS hostname');
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address, family }) => family === 4 ? privateIpv4(address) : privateIpv6(address))) {
    throw new Error(`Source host ${url.hostname} resolved to a non-public address`);
  }
}
