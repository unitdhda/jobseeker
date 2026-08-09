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
} from '../postgres.ts';
import { careerProfilePlatformId, parseStoredCareerProfile, type StoredCareerProfile } from '@jobseeker/engine';
import { refreshUserInWorker, tailorApplicationInWorker } from '../worker-client.ts';
import { type ApplicationArtifact } from '../postgres.ts';
import { maximumCvBytes } from '../cv.ts';
import { readResponseBytes } from '../http.ts';
import { errorMessage } from '../observability.ts';
import { getBot, targetChat } from './api.ts';
import { enabledSourceProviderIds } from '../vacancies/registry.ts';
import {
  artifactLabels,
  platformLabel,
  profileSearchTerms,
  searchProfileMessage,
  sourceLabel,
  type SearchProfilePlatformView,
} from './format.ts';
import { startEditableIndicator, type ApplicationLoader, type EditableIndicator } from './indicators.ts';
import { type UserWorkflowLease } from './workflow-lock.ts';
import { messages, userLocale, type Locale } from '../i18n/index.ts';


const refreshingUsers = new Set<string>();
async function startApplicationLoader(userId: string, applyId: string,
  artifact: ApplicationArtifact, locale: Locale): Promise<ApplicationLoader | null> {
  const indicator = await startEditableIndicator(userId, `${artifactLabels(locale)[artifact].loader} · ${applyId}`);
  return indicator ? { setTask: (task) => indicator.setLabel(task), stop: () => indicator.stop() } : null;
}

function applicationFailureMessage(error:unknown,retryId:string,artifact:ApplicationArtifact,locale:Locale):string{
  const message=error instanceof Error?error.message:String(error);
  const text=messages(locale).application;
  if(/daily tailored-cv limit/i.test(message))
    return text.withId(text.cvLimit(config.userDailyApplicationLimit),retryId);
  if(/daily cover-letter limit/i.test(message))
    return text.withId(text.letterLimit(config.userDailyCoverLetterLimit),retryId);
  if(/vacancy not found|scored vacancy .* was not found/i.test(message))return text.gone(retryId);
  if(/connection terminated|connection timeout|server closed the connection|socket hang up/i.test(message))
    return text.storeUnavailable(retryId);
  return text.failed(text.artifacts[artifact].noun,retryId);
}
async function generateAndSendApplication(userId: string, vacancyId: number, chat: string,
  artifact: ApplicationArtifact, lease: UserWorkflowLease): Promise<void> {
  let loader: ApplicationLoader | null = null; let vacancy: ScoredVacancy | null = null;
  const locale = await userLocale(userId); const text = messages(locale);
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
        caption: text.application.cvCaption(vacancy.name).slice(0, 1024) });
      else if (stored.text) await api.sendMessage(chat, stored.text, { link_preview_options: { is_disabled: true } });
      else throw new Error(`Stored ${artifact} artifact is empty.`);
      return;
    }
    loader = await startApplicationLoader(userId,vacancy.applyId,artifact,locale);
    const documents = await tailorApplicationInWorker(userId, vacancyId, artifact);
    if (!await isApprovedUser(userId)) throw new Error('User access was revoked during application generation.');
    loader?.setTask(artifactLabels(locale)[artifact].sending);
    const deliveredAt = new Date().toISOString();
    if (documents.tailoredCvPdf) {
      const sent = await api.sendDocument(chat, new InputFile(documents.tailoredCvPdf, `cv-${vacancyId}.pdf`), {
        caption: text.application.cvCaption(vacancy.name).slice(0, 1024),
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
    const keyboard = new InlineKeyboard().text(text.application.retryButton, `${artifact}:${vacancyId}`)
      .url(text.common.openAt(sourceLabel(vacancy?.source ?? '', locale)), vacancy?.url ?? 'https://hh.ru');
    const retryId=vacancy?.applyId??String(vacancyId);
    await getBot().api.sendMessage(chat, applicationFailureMessage(error,retryId,artifact,locale),
      { reply_markup: keyboard }).catch((notificationError)=>
      console.error(`Could not send application failure notice: ${errorMessage(notificationError)}`));
  } finally {
    await lease.release().catch((releaseError)=>console.warn(`Could not release application workflow: ${errorMessage(releaseError)}`));
  }
}
export async function runApplication(userId:string,vacancyId:number,chat:string,artifact:ApplicationArtifact,
  lease:UserWorkflowLease):Promise<void>{
  const task=generateAndSendApplication(userId,vacancyId,chat,artifact,lease);
  if(config.telegramMode==='webhook'){await task;return;}
  void task.catch((error)=>console.error(`Detached application task failed: ${errorMessage(error)}`));
}

export async function cvStatus(userId: string, locale: Locale): Promise<string> {
  const cv = await getCvSource(userId);
  return cv ? messages(locale).cv.present : messages(locale).cv.absent;
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
export async function searchProfileResult(userId: string, locale: Locale): Promise<{ text: string; complete: boolean }> {
  const cv = await getCvSource(userId);
  if (!cv) return { text: messages(locale).profile.cvMissing, complete: false };
  const career = parseStoredCareerProfile(
    await getSearchProfile<StoredCareerProfile>(userId, careerProfilePlatformId), cv.cvSha256,
  );
  const platforms: SearchProfilePlatformView[] = [];
  for (const platformId of enabledSourceProviderIds) {
    platforms.push({ label: platformLabel(platformId, locale),
      terms: profileSearchTerms(await getSearchProfile(userId, platformId)) });
  }
  const text = searchProfileMessage({ filename: cv.originalFilename,
    tracks: career?.tracks.map((track) => track.name) ?? [], platforms }, locale);
  // A constrained platform may legitimately have no supported search, so one ready platform is enough.
  return { text, complete: Boolean(career) && platforms.some((platform) => platform.terms.length > 0) };
}

export function cvRetryKeyboard(action: 'cv:retry' | 'cv:refresh', locale: Locale): InlineKeyboard {
  const text = messages(locale).cv;
  return new InlineKeyboard().text(action === 'cv:retry' ? text.retryUploadButton : text.retryRefreshButton, action);
}
export async function finishNotice(userId: string, indicator: EditableIndicator | null, text: string,
  keyboard?: InlineKeyboard): Promise<void> {
  if (indicator) { await indicator.finish(text, keyboard); return; }
  await getBot().api.sendMessage(await targetChat(userId), text,
    { parse_mode: 'HTML', reply_markup: keyboard, link_preview_options: { is_disabled: true } });
}
/** Takes ownership of both the indicator and lease; each always ends when the detached refresh does. */
export async function refreshSearchesAfterCvUpload(userId: string, indicator: EditableIndicator | null,
  lease: UserWorkflowLease, locale: Locale): Promise<void> {
  const notice = messages(locale).cv;
  const deliver = async (text: string, keyboard?: InlineKeyboard): Promise<void> => {
    const current = indicator; indicator = null;
    await finishNotice(userId, current, text, keyboard);
  };
  let cvHash: string | null = null;
  let readFailed = false;
  try { cvHash = await getCvHash(userId); }
  catch (error) { readFailed = true; console.error(`Could not read the stored CV of user ${userId}: ${errorMessage(error)}`); }
  if (!cvHash) {
    await deliver(readFailed ? notice.unreadable : notice.missing,
      cvRetryKeyboard(readFailed ? 'cv:refresh' : 'cv:retry', locale));
    await lease.release().catch((error) => console.warn(`Could not release profile workflow: ${errorMessage(error)}`));
    return;
  }
  // The durable lease is the real exclusion mechanism. This local check is only a last line of defence if a lease
  // expires while a worker is still returning.
  if (refreshingUsers.has(userId)) {
    await deliver(notice.refreshInFlight);
    await lease.release().catch((error) => console.warn(`Could not release duplicate profile workflow: ${errorMessage(error)}`));
    return;
  }
  refreshingUsers.add(userId);
  void (async () => {
    try {
      await refreshUserInWorker(userId, cvHash);
      if (await isApprovedUser(userId) && await getCvHash(userId) === cvHash) {
        const result = await searchProfileResult(userId, locale);
        await deliver(result.text, result.complete ? undefined : cvRetryKeyboard('cv:refresh', locale));
      }
    } catch (error) {
      if (await isApprovedUser(userId) && await getCvHash(userId)) {
        console.error(`Search-profile refresh failed for user ${userId}`,
          error instanceof Error ? error.message : String(error));
        await deliver(notice.refreshFailed, cvRetryKeyboard('cv:refresh', locale));
      }
    } finally {
      refreshingUsers.delete(userId);
      await indicator?.stop().catch((error) => console.warn(`Could not stop CV indicator: ${errorMessage(error)}`));
      await lease.release().catch((error) => console.warn(`Could not release profile workflow: ${errorMessage(error)}`));
    }
  })();
}

