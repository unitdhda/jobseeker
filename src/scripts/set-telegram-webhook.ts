const token = process.env.TELEGRAM_BOT_TOKEN;
const url = process.env.TELEGRAM_WEBHOOK_URL;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required.');
if (!url || new URL(url).protocol !== 'https:') throw new Error('TELEGRAM_WEBHOOK_URL must be an HTTPS URL.');
if (!secret || !/^[A-Za-z0-9_-]{32,256}$/.test(secret)) {
  throw new Error('TELEGRAM_WEBHOOK_SECRET must contain 32-256 URL-safe characters.');
}
const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ url, secret_token: secret, allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: false, max_connections: 20 }),
  signal: AbortSignal.timeout(30_000),
});
const result = await response.json() as { ok?: boolean; description?: string };
if (!response.ok || !result.ok) throw new Error(`Telegram setWebhook failed: ${response.status} ${result.description ?? ''}`.trim());
console.info('Telegram webhook configured successfully.');
