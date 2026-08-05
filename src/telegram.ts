/**
 * Compatibility surface for the split bot. The UI now lives in src/telegram/: api (instance and low-level send
 * mechanics), format (pure rendering), delivery (alerts and digests), indicators (editable progress messages),
 * actions (orchestration behind commands), bot (handlers, flows, lifecycle).
 */
export { usageTimelineChart, searchProfileMessage, type SearchProfilePlatformView, type SearchProfileView } from './telegram/format.ts';
export { sendDailyDigest, sendHighScoreAlert, sendPendingAlerts, type DigestDeliveryOptions } from './telegram/delivery.ts';
export { startCycleStatus, type CycleStatus, type CycleStatusPhase } from './telegram/indicators.ts';
export {
  handleTelegramWebhookUpdate, initializeTelegramWebhookHandler, initializeTelegramWebhookMode, startTelegramBot,
  stopTelegramBot,
} from './telegram/bot.ts'
