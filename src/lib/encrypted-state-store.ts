import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

interface EncryptedEnvelope {
  version: 1;
  algorithm: 'aes-256-gcm';
  iv: string;
  tag: string;
  ciphertext: string;
}

const binaryMagic = Buffer.from('JSTATE01');

function encryptionKey(): Buffer {
  const value = process.env.RUNTIME_STATE_ENCRYPTION_KEY;
  if (!value || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error('RUNTIME_STATE_ENCRYPTION_KEY must be a 32-byte hexadecimal key.');
  }
  return Buffer.from(value, 'hex');
}

function safeObjectPath(path: string): string {
  if (!/^(?:oauth|browser|healthcheck)\/[a-z0-9][a-z0-9._/-]{0,119}$/i.test(path)
    || path.includes('..') || path.includes('//')) {
    throw new Error('Runtime-state object path is invalid.');
  }
  return path.split('/').map(encodeURIComponent).join('/');
}

export function encryptRuntimeState(path: string, plaintext: Uint8Array): Uint8Array {
  safeObjectPath(path);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(Buffer.from(path));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([binaryMagic, iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptRuntimeState(path: string, encrypted: Uint8Array): Uint8Array {
  safeObjectPath(path);
  const bytes = Buffer.from(encrypted);
  let iv: Buffer; let tag: Buffer; let ciphertext: Buffer;
  if (bytes.subarray(0, binaryMagic.length).equals(binaryMagic)) {
    if (bytes.length < binaryMagic.length + 12 + 16) throw new Error('Encrypted runtime-state envelope is invalid.');
    iv = bytes.subarray(binaryMagic.length, binaryMagic.length + 12);
    tag = bytes.subarray(binaryMagic.length + 12, binaryMagic.length + 28);
    ciphertext = bytes.subarray(binaryMagic.length + 28);
  } else {
    let envelope: EncryptedEnvelope;
    try { envelope = JSON.parse(bytes.toString('utf8')) as EncryptedEnvelope; }
    catch (error) { throw new Error('Encrypted runtime-state envelope is invalid.', { cause: error }); }
    if (envelope.version !== 1 || envelope.algorithm !== 'aes-256-gcm'
      || typeof envelope.iv !== 'string' || typeof envelope.tag !== 'string' || typeof envelope.ciphertext !== 'string') {
      throw new Error('Encrypted runtime-state envelope version is unsupported.');
    }
    iv = Buffer.from(envelope.iv, 'base64');
    tag = Buffer.from(envelope.tag, 'base64');
    ciphertext = Buffer.from(envelope.ciphertext, 'base64');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
    decipher.setAAD(Buffer.from(path));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) { throw new Error('Encrypted runtime-state authentication failed.', { cause: error }); }
}

function storageConfig(): { base: string; key: string; bucket: string } {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
  const key = process.env.SUPABASE_SECRET_KEY;
  const bucket = process.env.SUPABASE_STORAGE_BUCKET;
  if (!url || !key || !bucket) throw new Error('Supabase runtime-state storage is not configured.');
  return { base: `${url}/storage/v1/object/${encodeURIComponent(bucket)}`, key, bucket };
}

function storageHeaders(key: string): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}` };
}

export async function putEncryptedRuntimeState(path: string, plaintext: Uint8Array): Promise<void> {
  const config = storageConfig();
  const body = Uint8Array.from(encryptRuntimeState(path, plaintext)).buffer;
  const response = await fetch(`${config.base}/${safeObjectPath(path)}`, {
    method: 'POST',
    headers: { ...storageHeaders(config.key), 'Content-Type': 'application/octet-stream', 'x-upsert': 'true' },
    body,
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Supabase runtime-state upload failed: ${response.status}.`);
}

export async function getEncryptedRuntimeState(path: string): Promise<Uint8Array | null> {
  const config = storageConfig();
  const response = await fetch(`${config.base}/${safeObjectPath(path)}`, {
    headers: storageHeaders(config.key), signal: AbortSignal.timeout(60_000),
  });
  if (response.status === 400 || response.status === 404) return null;
  if (!response.ok) throw new Error(`Supabase runtime-state download failed: ${response.status}.`);
  return decryptRuntimeState(path, new Uint8Array(await response.arrayBuffer()));
}

export async function deleteEncryptedRuntimeState(path: string): Promise<void> {
  const config = storageConfig();
  const response = await fetch(`${config.base}/${safeObjectPath(path)}`, {
    method: 'DELETE', headers: storageHeaders(config.key), signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok && response.status !== 404) throw new Error(`Supabase runtime-state deletion failed: ${response.status}.`);
}
