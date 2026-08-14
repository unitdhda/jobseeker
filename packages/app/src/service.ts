import { resolve } from 'node:path';
import { AdaptiveTaskPool } from '@jobseeker/engine/concurrency';
import { nextWakeMs } from '@jobseeker/engine/runtime';
import { InputFile } from 'grammy';
import { composeApplication } from './composition.ts';
import { config } from './config.ts';
import { createCredentialStore } from './ai-auth.ts';
import { createMatchingVocabularies } from './matching-vocabularies.ts';
import { createEnginePorts } from './engine-adapters.ts';
import { startEngineOwnership, type EngineOwnership } from './engine-main.ts';
import { createJobWorkerClient, type JobWorkerClient } from './worker-client.ts';
import { createScoringWorkflowPorts } from './workflow-adapters.ts';
import { createTelegramApi, downloadTelegramFile, telegramSendError } from './telegram/api.ts';
import { installTelegramRoutes } from './telegram/bot.ts';
import { resolveLocale } from './i18n/index.ts';
import { createCommandHandlers } from './telegram/commands.ts';
import { routeTelegramCallback } from './telegram/callbacks.ts';
import { sendHighAlerts, sendScheduledDigest } from './telegram/delivery.ts';
import { grammYReceiver, startTelegramOwnership, type TelegramOwnership } from './telegram/ownership.ts';
import { createOwnerMessageHistory } from './telegram/owner-message-history.ts';
import { createWebApp, createOrderedShutdown, startHttpServer, type HttpServerHandle } from './web.ts';
import { safeErrorMessage } from './security.ts';
import { createCvParser, nodeCvParserCommand } from './cv.ts';
import { processCvUpload } from './telegram/actions.ts';
import { escapeHtml } from './telegram/format.ts';
import { messages } from './i18n/index.ts';
import { bundledEntryPath, packageRootPath } from './deployment-paths.ts';
import { parseUserId, type UserId } from '@jobseeker/engine/contracts';
import type { AlertVacancy, Store } from '@jobseeker/store';

function vocabularies(store: Store) {
  return createMatchingVocabularies({ loadRoleEquivalences: store.loadRoleEquivalences,
    loadIdfVocabulary: store.loadIdfVocabulary, roleTrackTitles: store.roleTrackTitles,
    vacancyTextBatch: store.vacancyTextBatch, replaceRoleEquivalences: store.replaceRoleEquivalences,
    replaceMatchingVocabularies: store.replaceMatchingVocabularies });
}
function unavailableWorker(): Pick<JobWorkerClient, 'request'> {
  return { request: async () => { throw new Error('General job worker is disabled.'); } };
}
function utcDayHour(value: Date): string { return value.toISOString().slice(0, 13); }

export async function startService(): Promise<void> {
  const composition = await composeApplication(config, { errorMessage: safeErrorMessage });
  const vocabulary = vocabularies(composition.store);
  const bot = config.telegramMode === 'off' ? null : createTelegramApi(config.telegramBotToken ?? '');
  const receiver = bot ? grammYReceiver(bot) : null;
  let telegram: TelegramOwnership | null = null; let worker: JobWorkerClient | null = null;
  let engine: EngineOwnership | null = null; let http: HttpServerHandle | null = null;
  let shutdown: (() => Promise<void>) | null = null;
  try {
    if (config.engineMode === 'run' || config.telegramMode !== 'off') {
      worker = createJobWorkerClient({ command: { modulePath: bundledEntryPath(import.meta.url, 'worker.js') },
        maxPending: config.maxPendingWorkerJobs });
      await worker.ready;
    }
    const workerPort = worker ?? unavailableWorker();
    const deliveryPorts = composition.store;
    if (bot && receiver) {
      const root = packageRootPath(import.meta.url);
      const parser = createCvParser({ command: nodeCvParserCommand(bundledEntryPath(import.meta.url, 'cv-worker.js'),
        [root, resolve(root, '../..')], { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
          TMPDIR: process.env.TMPDIR ?? '/tmp', LANG: process.env.LANG ?? 'C.UTF-8' }) });
      const applicationTransport = {
        sendDocument: async (userId: UserId, bytes: Uint8Array, filename: string) => {
          const message = await bot.api.sendDocument(Number(userId), new InputFile(Buffer.from(bytes), filename));
          const fileId = message.document?.file_id; if (!fileId) throw new Error('Telegram returned no document file ID.'); return { fileId };
        },
        sendFileId: async (userId: UserId, fileId: string) => { await bot.api.sendDocument(Number(userId), fileId); },
        sendText: async (userId: UserId, text: string) => { await bot.api.sendMessage(Number(userId), text); },
      };
      const ownerMessageHistory = createOwnerMessageHistory(async (userId, messageId) => {
        await bot.api.deleteMessage(Number(userId), messageId);
      });
      const commandHandlers = createCommandHandlers({ store: composition.store, cvActions: composition.store,
        applicationActions: composition.store, worker: workerPort, applicationTransport, delivery: deliveryPorts,
        transport: { reply: async (userId, html) => (await bot.api.sendMessage(Number(userId), html, { parse_mode: 'HTML' })).message_id,
          sendDocument: async (userId, bytes, filename) => { await bot.api.sendDocument(Number(userId), new InputFile(Buffer.from(bytes), filename)); },
          confirmDelete: async (userId) => { await bot.api.sendMessage(Number(userId), 'Confirm deletion?', {
            reply_markup: { inline_keyboard: [[{ text: 'Delete', callback_data: 'privacy:delete' }]] } }); } },
        ownerMessageHistory, configuredSources: composition.enabledSourceProviderIds, digestMinScore: config.digestMinScore, alertScore: config.alertScore,
        defaultTimezone: config.timezone, runtimeStatus: () => ({ uptimeMs: process.uptime() * 1000,
          rssBytes: process.memoryUsage().rss, heapBytes: process.memoryUsage().heapUsed, cpuPercent: 0,
          workerPending: worker?.pendingCount ?? 0, aiActive: 0, aiQueued: 0, telegramMode: config.telegramMode,
          engineRunning: engine?.loop?.status().running ?? false,
          discoveryStatus: engine?.loop?.status().discovery.lastStageFailures.join(',') || 'idle',
          judgmentStatus: engine?.loop?.status().judgment.lastStageFailures.join(',') || 'idle' }) });
      installTelegramRoutes(bot, composition.store, config.defaultLocale, { handlers: commandHandlers,
        setCommands: (userId, locale, commands) => receiver.setUserCommands(userId, locale, commands),
        notifyOwner: async (text) => { if (config.ownerTelegramUserId) await bot.api.sendMessage(Number(config.ownerTelegramUserId), text); },
        document: async (document) => {
          const result = await processCvUpload({ ports: composition.store, parser, userId: document.user.userId,
            document: { filename: document.filename, mediaType: document.mediaType, declaredSize: document.declaredSize,
              download: async () => { const file = await bot.api.getFile(document.fileId); if (!file.file_path) throw new Error('Telegram returned no file path.');
                return downloadTelegramFile({ token: bot.token, filePath: file.file_path }); } }, errorMessage: safeErrorMessage });
          const t = messages(document.locale);
          if (result.kind === 'busy') { await bot.api.sendMessage(Number(document.user.userId), t.busy(result.claim.current.kind)); return; }
          if (result.kind === 'invalid') { await bot.api.sendMessage(Number(document.user.userId), escapeHtml(result.error), { parse_mode: 'HTML' }); return; }
          const preview = result.preview;
          const html = `<b>${escapeHtml(preview.filename)}</b>\n${preview.characterCount} chars · ${preview.blockCount} blocks\n\n${escapeHtml(preview.excerpt)}`;
          await bot.api.sendMessage(Number(document.user.userId), html, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[
            { text: 'Confirm', callback_data: 'cv:confirm' }, { text: 'Reject', callback_data: 'cv:reject' }]] } });
        },
        callback: async (callback) => {
          const stored = await composition.store.getTelegramUser(String(callback.senderId) as UserId);
          const locale = resolveLocale({ stored: stored?.locale ?? null, explicitlySelected: stored?.localeSelected ?? false,
            clientLanguage: callback.languageCode, defaultLocale: config.defaultLocale });
          await routeTelegramCallback({ data: callback.data, senderId: callback.senderId, locale,
            ports: { store: composition.store, cvActions: composition.store, applicationActions: composition.store,
              worker: workerPort, applicationTransport, delivery: deliveryPorts,
              digestMinScore: config.digestMinScore, alertScore: config.alertScore },
            transport: { answer: callback.answer, edit: callback.edit } });
        } });
      telegram = await startTelegramOwnership({ mode: config.telegramMode, bot: receiver,
        ownerUserId: config.ownerTelegramUserId ? parseUserId(config.ownerTelegramUserId) : undefined,
        webhookUrl: config.telegramWebhookUrl, webhookSecret: config.telegramWebhookSecret });
    } else {
      telegram = await startTelegramOwnership({ mode: 'off', bot: {
        init: async () => undefined, start: async () => undefined, stop: async () => undefined,
        handleUpdate: async () => undefined, setWebhook: async () => undefined, deleteWebhook: async () => undefined,
        deleteCommands: async () => undefined, deleteUserCommands: async () => undefined,
        setUserCommands: async () => undefined } });
    }
    const scorePool = new AdaptiveTaskPool(config.scoreConcurrencyMin, config.scoreConcurrencyMax);
    const scoreStore = Object.assign(Object.create(composition.store), createScoringWorkflowPorts(composition.store));
    const enginePorts = createEnginePorts({ store: scoreStore, sources: composition.sources, vocabularies: vocabulary,
      models: composition.ai, scorePool, config, errorMessage: safeErrorMessage,
      deliver: async (now) => {
        if (!bot) return;
        for (const user of await composition.store.approvedUsers(false)) {
          const locale = resolveLocale({ stored: user.locale, explicitlySelected: user.localeSelected, defaultLocale: config.defaultLocale });
          const transport = { sendAlert: async (_userId: UserId, html: string, vacancy: AlertVacancy) => {
              try { await bot.api.sendMessage(Number(user.userId), html, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[
                { text: 'CV', callback_data: `apply:cv:${vacancy.id}` }, { text: 'Letter', callback_data: `apply:letter:${vacancy.id}` },
                { text: 'Skip', callback_data: `skip:${vacancy.id}` }, { text: 'Open', url: vacancy.url.href }]] } }); }
              catch (error) { throw telegramSendError(error); } },
            sendDigest: async (_userId: UserId, html: string) => { try { await bot.api.sendMessage(Number(user.userId), html, { parse_mode: 'HTML' }); }
              catch (error) { throw telegramSendError(error); } } };
          await sendHighAlerts({ userId: user.userId, locale, minimumScore: config.alertScore, ports: composition.store, transport });
          const settings = await composition.store.getDeliverySettings(user.userId);
          if (settings?.enabled && settings.digestHourUtc === now.getUTCHours()
            && (!settings.lastDigestAt || utcDayHour(settings.lastDigestAt) !== utcDayHour(now))) {
            await sendScheduledDigest({ userId: user.userId, locale, since: settings.lastDigestAt, until: now,
              minimumScore: config.digestMinScore, alertScore: config.alertScore, ports: composition.store, transport });
          }
        }
      } });
    if (config.engineMode === 'run') engine = await startEngineOwnership({ store: composition.store, sources: composition.sources,
      extensions: composition.extensions, vocabularies: vocabulary, ports: enginePorts,
      clocks: { discovery: { nextWakeMs: async (now) => { const next = await composition.store.nextUnitDueAt(); return nextWakeMs(next ? [{ nextRunAt: next }] : [], now); },
          sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)) },
        judgment: { nextWakeMs: async () => 60_000, sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)) } } });
    const web = createWebApp({ telegramMode: config.telegramMode, webhookSecret: config.telegramWebhookSecret,
      ports: { persistenceReady: composition.store.ready, claimTelegramUpdate: composition.store.claimTelegramUpdate,
        completeTelegramUpdate: composition.store.completeTelegramUpdate, failTelegramUpdate: composition.store.failTelegramUpdate,
        handleTelegramUpdate: async (update) => { if (!telegram || !await telegram.handleWebhook(update, config.telegramWebhookSecret)) throw new Error('Webhook receiver unavailable.'); } } });
    http = startHttpServer(web, config.appPort);
    shutdown = createOrderedShutdown({ stopEngine: () => engine?.stop() ?? Promise.resolve(),
      stopTelegram: () => telegram?.stop() ?? Promise.resolve(), stopWorker: () => worker?.close() ?? Promise.resolve(),
      stopHttp: () => http?.close() ?? Promise.resolve(), closeApplication: () => composition.close() });
    await new Promise<void>((resolveSignal) => {
      const stop = () => { process.off('SIGTERM', stop); process.off('SIGINT', stop); resolveSignal(); };
      process.once('SIGTERM', stop); process.once('SIGINT', stop);
    });
    await shutdown();
  } catch (error) {
    shutdown ??= createOrderedShutdown({ stopEngine: () => engine?.stop() ?? Promise.resolve(),
      stopTelegram: () => telegram?.stop() ?? Promise.resolve(), stopWorker: () => worker?.close() ?? Promise.resolve(),
      stopHttp: () => http?.close() ?? Promise.resolve(), closeApplication: () => composition.close() });
    await shutdown().catch(() => undefined); throw error;
  }
}

export async function openCredentialBackend() {
  const composition = await composeApplication({ ...config, telegramMode: 'off', engineMode: 'off' });
  const store = createCredentialStore({ state: composition.state, filePath: config.aiAuthFile,
    withAdvisoryLock: (key, operation) => composition.store.withAdvisoryLock(key, async () => operation()) });
  return { store, backend: composition.state.configured() ? 'encrypted-object' : 'local-file', close: () => composition.close() };
}
export async function openCredentialModels() {
  const composition = await composeApplication({ ...config, telegramMode: 'off', engineMode: 'off' });
  return { models: composition.ai, backend: composition.state.configured() ? 'encrypted-object' : 'local-file', close: () => composition.close() };
}
