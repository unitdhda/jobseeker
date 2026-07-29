#!/usr/bin/env node
import { open, stat } from 'node:fs/promises';
import process from 'node:process';

const file = process.argv[2] ?? 'data/test-run/server.log';
const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
if (!token || !chatId) throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required.');

let position = 0;
let carry = '';
let stopping = false;
const queue = [];

async function telegram(text) {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_notification: true, link_preview_options: { is_disabled: true } }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    let retryAfter = 0;
    try { retryAfter = Number((await response.json()).parameters?.retry_after ?? 0); } catch { /* ignore */ }
    if (retryAfter > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1_000));
      return telegram(text);
    }
    throw new Error(`Telegram sendMessage failed with status ${response.status}`);
  }
}

function redact(text) {
  return text
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g, '[telegram-token-redacted]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '[authorization-redacted]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email-redacted]')
    .replace(/(?<!\w)(?:\+?\d[\d ()-]{8,}\d)(?!\w)/g, '[phone-redacted]')
    .replace(/("?(?:access|refresh|token|secret|password|credential)"?\s*[:=]\s*)[^\s,}]+/gi, '$1[redacted]');
}

function enqueue(text) {
  const prefix = '🧪 local jobseeker log (redacted)\n';
  const sanitized = redact(text);
  const limit = 3_700 - prefix.length;
  for (let start = 0; start < sanitized.length; start += limit) queue.push(prefix + sanitized.slice(start, start + limit));
}

async function readNew() {
  let size;
  try { size = (await stat(file)).size; } catch { return; }
  if (size < position) { position = 0; carry = ''; }
  if (size === position) return;
  const handle = await open(file, 'r');
  try {
    const length = size - position;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, position);
    position = size;
    const content = carry + buffer.toString('utf8');
    const lines = content.split('\n');
    carry = lines.pop() ?? '';
    if (lines.length) enqueue(lines.join('\n'));
  } finally { await handle.close(); }
}

async function sendQueued() {
  if (!queue.length) return;
  const message = queue.shift();
  try { await telegram(message); }
  catch (error) { console.error('Log forward failed:', error instanceof Error ? error.message : String(error)); }
}

try {
  position = (await stat(file)).size;
} catch { position = 0; }

process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
await telegram(`🧪 Local jobseeker log forwarding started\nFile: ${file}\nPID: ${process.pid}`);
console.info(`Forwarding new lines from ${file} to configured Telegram chat (PID ${process.pid})`);
while (!stopping) {
  await readNew();
  await sendQueued();
  await new Promise((resolve) => setTimeout(resolve, 500));
}
await readNew();
if (carry) enqueue(carry);
while (queue.length) await sendQueued();
await telegram('🧪 Local jobseeker log forwarding stopped');
