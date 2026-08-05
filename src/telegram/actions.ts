import { InlineKeyboard, InputFile } from 'grammy';
import { config } from '../config.ts';
import {
  getCvHash,
  getCvSource,
  getScoredVacancy,
  getSearchProfile,
  isApprovedUser,
  markApplicationDelivered,
  type ScoredVacancy,
  deliveredArtifact, saveDeliveredArtifact,
} from '@jobseeker/store';
import { careerProfilePlatformId, parseStoredCareerProfile, type StoredCareerProfile } from '../prefilter.ts';
import { refreshUserInWorker, tailorApplicationInWorker } from '../worker-client.ts';
import { type ApplicationArtifact } from '@jobseeker/store';
import { clearApplicationArtifacts } from '../documents.ts';
import { maximumCvBytes } from '../cv.ts';
import { readResponseBytes } from '@jobseeker/sources';
import { errorMessage } from '../observability.ts';
import { getBot, targetChat } from './api.ts';
import {
  artifactLabels,
  platformLabel,
  profileSearchTerms,
  searchProfileMessage,
  sourceLabel,
  type SearchProfilePlatformView,
} from './format.ts';
import { startEditableIndicator, type ApplicationLoader, type EditableIndicator } from './indicators.ts';


export const activeCvImports = new Set<string>();
export const applicationJobs = new Set<string>();
export const pendingRefreshHashes = new Map<string, string>();
export const refreshingUsers = new Set<string>();
async function startApplicationLoader(userId: string, applyId: string,
  artifact: ApplicationArtifact): Promise<ApplicationLoader | null> {
  const indicator = await startEditableIndicator(userId, `${artifactLabels[artifact].loader} · ${applyId}`);
  return indicator ? { setTask: (task) => indicator.setLabel(task), stop: () => indicator.stop() } : null;
}

function applicationFailureMessage(error:unknown,retryId:string,artifact:ApplicationArtifact):string{
  const message=error instanceof Error?error.message:String(error);
  const noun=artifactLabels[artifact].noun;
  if(/daily tailored-cv limit/i.test(message))return `Дневной лимит адаптированных резюме (${config.userDailyApplicationLimit}) исчерпан. Письмо всё ещё можно подготовить. ID: ${retryId}.`;
  if(/daily cover-letter limit/i.test(message))return `Дневной лимит сопроводительных писем (${config.userDailyCoverLetterLimit}) исчерпан. ID: ${retryId}.`;
  if(/vacancy not found|scored vacancy .* was not found/i.test(message))return `Вакансия ${retryId} больше недоступна для подготовки документов.`;
  if(/connection terminated|connection timeout|server closed the connection|socket hang up/i.test(message))
    return `Временная ошибка базы данных для вакансии ${retryId}. Пришлите ID ещё раз.`;
  return `Не удалось подготовить ${noun} для вакансии ${retryId}. Пришлите ID ещё раз или нажмите кнопку.`;
}
async function generateAndSendApplication(userId: string, vacancyId: number, chat: string,
  artifact: ApplicationArtifact): Promise<void> {
  const jobKey = `${userId}:${vacancyId}:${artifact}`;
  if (applicationJobs.has(jobKey)) return;
  applicationJobs.add(jobKey); let loader: ApplicationLoader | null = null; let vacancy: ScoredVacancy | null = null;
  try {
    vacancy = await getScoredVacancy(userId, vacancyId);
    if (!vacancy) throw new Error('Vacancy not found.');
    const api = getBot().api;
    // A repeat request for an artifact built from the current CV resends what was already delivered: a Telegram
    // file_id upload costs nothing and no LLM run or daily-limit slot is spent on work that already happened.
    const cvHash = await getCvHash(userId);
    const stored = await deliveredArtifact(userId, vacancyId, artifact);
    if (stored && cvHash && stored.cvSha256 === cvHash) {
      if (stored.fileId) await api.sendDocument(chat, stored.fileId, {
        caption: `Адаптированное резюме — ${vacancy.name}`.slice(0, 1024) });
      else if (stored.text) await api.sendMessage(chat, stored.text, { link_preview_options: { is_disabled: true } });
      else throw new Error(`Stored ${artifact} artifact is empty.`);
      return;
    }
    loader = await startApplicationLoader(userId,vacancy.applyId,artifact);
    const documents = await tailorApplicationInWorker(userId, vacancyId, artifact);
    if (!await isApprovedUser(userId)) throw new Error('User access was revoked during application generation.');
    loader?.setTask(artifactLabels[artifact].sending);
    const deliveredAt = new Date().toISOString();
    if (documents.tailoredCvPdf) {
      const sent = await api.sendDocument(chat, new InputFile(documents.tailoredCvPdf, `cv-${vacancyId}.pdf`), {
        caption: `Адаптированное резюме — ${vacancy.name}`.slice(0, 1024),
      });
      if (cvHash && sent.document?.file_id) await saveDeliveredArtifact(userId, vacancyId, artifact,
        { cvSha256: cvHash, fileId: sent.document.file_id, deliveredAt }).catch((saveError) =>
        console.warn(`Could not store delivered cv artifact: ${errorMessage(saveError)}`));
    } else if (documents.coverLetter) {
      await api.sendMessage(chat, documents.coverLetter, { link_preview_options: { is_disabled: true } });
      if (cvHash) await saveDeliveredArtifact(userId, vacancyId, artifact,
        { cvSha256: cvHash, text: documents.coverLetter, deliveredAt }).catch((saveError) =>
        console.warn(`Could not store delivered letter artifact: ${errorMessage(saveError)}`));
    } else throw new Error(`Application worker returned no ${artifact}.`);
    await markApplicationDelivered(userId, vacancyId, artifact); await loader?.stop();
  } catch (error) {
    await loader?.stop().catch((stopError)=>console.warn(`Could not stop application indicator: ${errorMessage(stopError)}`));
    console.error(`Application generation failed: ${errorMessage(error)}`);
    const keyboard = new InlineKeyboard().text('Попробовать снова', `${artifact}:${vacancyId}`)
      .url(`Открыть ${sourceLabel(vacancy?.source ?? '')}`, vacancy?.url ?? 'https://hh.ru');
    const retryId=vacancy?.applyId??String(vacancyId);
    await getBot().api.sendMessage(chat, applicationFailureMessage(error,retryId,artifact),
      { reply_markup: keyboard }).catch((notificationError)=>
      console.error(`Could not send application failure notice: ${errorMessage(notificationError)}`));
  } finally {
    applicationJobs.delete(jobKey); clearApplicationArtifacts(userId, vacancyId);
  }
}
export async function runApplication(userId:string,vacancyId:number,chat:string,artifact:ApplicationArtifact):Promise<void>{
  const task=generateAndSendApplication(userId,vacancyId,chat,artifact);
  if(config.telegramMode==='webhook'){await task;return;}
  void task.catch((error)=>console.error(`Detached application task failed: ${errorMessage(error)}`));
}

export async function cvStatus(userId: string): Promise<string> {
  const cv = await getCvSource(userId);
  return cv ? 'Резюме загружено' : 'Резюме не загружено';
}
export async function downloadTelegramFile(fileId: string, declaredSize?: number): Promise<Uint8Array> {
  if (declaredSize != null && declaredSize > maximumCvBytes) throw new Error('CV document exceeds the 20 MB limit.');
  const file = await getBot().api.getFile(fileId);
  if (!file.file_path || file.file_path.includes('..') || file.file_path.startsWith('/')) {
    throw new Error('Telegram returned an invalid file path.');
  }
  const response = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`,
    { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
  return readResponseBytes(response, maximumCvBytes);
}
export async function searchProfileResult(userId: string): Promise<{ text: string; complete: boolean }> {
  const cv = await getCvSource(userId);
  if (!cv) return { text: 'Резюме не загружено. Отправьте /cv, чтобы загрузить файл.', complete: false };
  const career = parseStoredCareerProfile(
    await getSearchProfile<StoredCareerProfile>(userId, careerProfilePlatformId), cv.cvSha256,
  );
  const platforms: SearchProfilePlatformView[] = [];
  for (const platformId of config.searchPlatforms) {
    platforms.push({ label: platformLabel(platformId), terms: profileSearchTerms(await getSearchProfile(userId, platformId)) });
  }
  const text = searchProfileMessage({ filename: cv.originalFilename,
    tracks: career?.tracks.map((track) => track.name) ?? [], platforms });
  // A constrained platform may legitimately have no supported search, so one ready platform is enough.
  return { text, complete: Boolean(career) && platforms.some((platform) => platform.terms.length > 0) };
}

export function cvRetryKeyboard(action: 'cv:retry' | 'cv:refresh'): InlineKeyboard {
  return new InlineKeyboard().text(action === 'cv:retry' ? 'Загрузить резюме заново' : 'Повторить подготовку', action);
}
export async function finishNotice(userId: string, indicator: EditableIndicator | null, text: string,
  keyboard?: InlineKeyboard): Promise<void> {
  if (indicator) { await indicator.finish(text, keyboard); return; }
  await getBot().api.sendMessage(await targetChat(userId), text,
    { parse_mode: 'HTML', reply_markup: keyboard, link_preview_options: { is_disabled: true } });
}
// The refresh loop outlives the request that started it, so the indicator it must turn into a result is
// handed over here rather than captured by the caller.
const refreshIndicators = new Map<string, EditableIndicator>();
async function deliverRefreshResult(userId: string, text: string, keyboard?: InlineKeyboard): Promise<void> {
  const indicator = refreshIndicators.get(userId) ?? null;
  refreshIndicators.delete(userId);
  await finishNotice(userId, indicator, text, keyboard);
}

/** Takes ownership of the indicator, so it always ends as a result and never keeps spinning after a failure. */
export async function refreshSearchesAfterCvUpload(userId: string, indicator: EditableIndicator | null = null): Promise<void> {
  if (indicator) {
    const previous = refreshIndicators.get(userId);
    refreshIndicators.set(userId, indicator);
    if (previous) await previous.stop().catch((error) => console.warn(`Could not stop CV indicator: ${errorMessage(error)}`));
  }
  let cvHash: string | null = null;
  let readFailed = false;
  try { cvHash = await getCvHash(userId); }
  catch (error) { readFailed = true; console.error(`Could not read the stored CV of user ${userId}: ${errorMessage(error)}`); }
  if (!cvHash) {
    await deliverRefreshResult(userId, readFailed
      ? 'Не удалось прочитать сохранённое резюме. Попробуйте ещё раз.'
      : 'Резюме не найдено. Загрузите файл заново командой /cv.',
      cvRetryKeyboard(readFailed ? 'cv:refresh' : 'cv:retry'));
    return;
  }
  pendingRefreshHashes.set(userId, cvHash);
  if (refreshingUsers.has(userId)) return;
  refreshingUsers.add(userId);
  void (async () => {
    try {
      while (await isApprovedUser(userId)) {
        const requestedHash = pendingRefreshHashes.get(userId);
        if (!requestedHash) break;
        pendingRefreshHashes.delete(userId);
        try {
          await refreshUserInWorker(userId, requestedHash);
          if (!pendingRefreshHashes.has(userId) && await isApprovedUser(userId) && await getCvHash(userId) === requestedHash) {
            const result = await searchProfileResult(userId);
            await deliverRefreshResult(userId, result.text, result.complete ? undefined : cvRetryKeyboard('cv:refresh'));
          }
        } catch (error) {
          if (!pendingRefreshHashes.has(userId) && await isApprovedUser(userId) && await getCvHash(userId)) {
            console.error(`Search-profile refresh failed for user ${userId}`,
              error instanceof Error ? error.message : String(error));
            await deliverRefreshResult(userId,
              'Резюме сохранено, но поисковые настройки пока не удалось обновить. Бот повторит попытку в следующем цикле, когда позволит лимит.',
              cvRetryKeyboard('cv:refresh'));
          }
        }
      }
    } finally {
      pendingRefreshHashes.delete(userId);
      refreshingUsers.delete(userId);
      const leftover = refreshIndicators.get(userId);
      if (leftover) {
        refreshIndicators.delete(userId);
        await leftover.stop().catch((error) => console.warn(`Could not stop CV indicator: ${errorMessage(error)}`));
      }
    }
  })();
}

