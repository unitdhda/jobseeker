import { Bot, InlineKeyboard, InputFile, type Context } from 'grammy';
import type { InputRichBlockTable, InputRichMessage, RichBlockTableCell, RichText } from 'grammy/types';
import { config } from './config.ts';
import {
  approvedUsers, currentDigestVacancies, deleteUserData, digestVacancies, exportUserData, getCvHash, getCvSource, getDeliverySettings,
  getScoredVacancy, getScoredVacancyByApplyId, getTelegramUser, isApprovedUser, latestDigestVacanciesByApplyIdPrefix, listTelegramUsers,
  markAlerted, markApplicationDelivered, replaceDigestSnapshot, requestAccess, searchScoredVacancies, setUserStatus,
  skipVacancy, touchTelegramUser, unsentHighScoreVacancies, userUsageSummaries, llmUsageSummary,
  type AlertVacancy, type ScoredVacancy, type TelegramIdentity, type TelegramUser, type UsageHour,
} from './database.ts';
import { importCvSource } from './cv.ts';
import { jobWorkerStatus, refreshUserInWorker, tailorApplicationInWorker } from './worker-client.ts';
import { clearApplicationArtifacts } from './documents.ts';
import { maximumCvBytes } from './cv.ts';
import { readResponseBytes } from './vacancies/http.ts';
import { errorMessage } from './observability.ts';
import { claimTelegramSession, deleteTelegramSession, getTelegramSession, setTelegramSession } from './telegram-state.ts';
import {
  deliverySettingsStatus, normalizeUtcOffset, parseClockMinutes, removeDeliveryWindow,
  updateDeliveryTimezone, updateDeliveryWindow, updateDigestTime,
} from './vacancies/jobs.ts';

let bot: Bot | undefined;
let botConfigured = false;
const activeCvImports = new Set<string>();
const applicationJobs = new Set<string>();
const pendingRefreshHashes = new Map<string, string>();
const refreshingUsers = new Set<string>();
const latestUserPages = new Map<string, string[]>();
type WindowSetup = { step: 'start' | 'end' | 'digest' | 'timezone'; start?: string };
const usersPageSize = 8;
const cvUploadSessionTtlMs = 30 * 60_000;
const windowSetupTtlMs = 30 * 60_000;

function getBot(): Bot {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required.');
  return bot ??= new Bot(token);
}
function ownerUserId(): string {
  if (!config.telegramUserId) throw new Error('TELEGRAM_USER_ID is required for the bot owner.');
  return config.telegramUserId;
}
async function targetChat(userId: string): Promise<string> {
  const user = await getTelegramUser(userId);
  if (!user) throw new Error(`Telegram user ${userId} was not found.`);
  return user.chatId;
}
function identity(ctx: Context): TelegramIdentity | null {
  if (!ctx.from || !ctx.chat || ctx.chat.type !== 'private') return null;
  const displayName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || ctx.from.username || String(ctx.from.id);
  return { userId: String(ctx.from.id), chatId: String(ctx.chat.id), username: ctx.from.username, displayName };
}
function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
function sourceLabel(source: string): string {
  return ({ hh: 'HH', habr: 'Habr Career', rabota: 'Работа.ру', hirehi: 'HireHi' } as Record<string, string>)[source] ?? 'источник';
}
function userStatusText(status: TelegramUser['status']): string {
  return ({ unregistered: 'не зарегистрирован', pending: 'на рассмотрении', approved: 'одобрен',
    rejected: 'отклонён', revoked: 'отозван' } as const)[status];
}
const usagePlotHours=24,usagePlotWidth=usagePlotHours*2+1,usagePlotHeight=12;
function niceUsageStep(maximum:number):number{
  if(maximum<=0)return 0;const raw=maximum/usagePlotHeight,power=10**Math.floor(Math.log10(raw)),scaled=raw/power;
  return (scaled<=1?1:scaled<=2?2:scaled<=5?5:10)*power;
}
function localHourLabel(timestamp:string,timezone:string):string{
  const date=new Date(timestamp),offset=/^([+-])(\d{2}):?(\d{2})$/.exec(timezone);
  if(offset){const minutes=(Number(offset[2])*60+Number(offset[3]))*(offset[1]==='-'?-1:1);
    return `${String(new Date(date.getTime()+minutes*60_000).getUTCHours()).padStart(2,'0')}`;}
  return new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'2-digit',hourCycle:'h23'}).format(date);
}
function axisInteger(value:number):string{return Math.round(value).toLocaleString('ru-RU').replace(/[\u00a0\u202f]/g,' ');}
function axisMoney(value:number,maximum:number):string{
  const digits=maximum>=0.01?3:maximum>=0.001?4:6;return `$${value.toFixed(digits)}`;
}
function placeLabel(target:string[],center:number,label:string):void{
  const start=Math.max(0,Math.min(target.length-label.length,center-Math.floor(label.length/2)));
  for(let index=0;index<label.length;index++)target[start+index]=label[index]!;
}
const boldUsageStroke:Record<string,string>={'─':'━','│':'┃','╭':'┏','╮':'┓','╯':'┛','╰':'┗'};
function drawUsageSeries(values:number[],maximum:number,marker:'●'|'○'):string[][]{
  const grid=Array.from({length:usagePlotHeight},()=>Array<string>(usagePlotWidth).fill(' '));
  const rows=values.map(value=>maximum<=0?usagePlotHeight-1:
    Math.round((1-Math.max(0,Math.min(value/maximum,1)))*(usagePlotHeight-1)));
  const put=(row:number,column:number,symbol:string,force=false):void=>{
    const current=grid[row]![column]!;
    if(force){grid[row]![column]=symbol;return;}
    if(current===' '||('╭╮╯╰'.includes(symbol)&&current!=='●'&&current!=='○'))grid[row]![column]=symbol;
  };
  for(let hour=0;hour<usagePlotHours;hour++){
    const column=hour*2,nextColumn=column+2,row=rows[hour]!,nextRow=rows[hour+1]!;
    if(row===nextRow){put(row,column,'─');put(row,column+1,'─');put(row,nextColumn,'─');continue;}
    if(nextRow<row){
      put(row,column,'─');put(row,column+1,'╯');
      for(let vertical=nextRow+1;vertical<row;vertical++)put(vertical,column+1,'│');
      put(nextRow,column+1,'╭');put(nextRow,nextColumn,'─');continue;
    }
    // A fall holds its row across the connector and turns down over the landing point, so the point
    // itself closes the drop; a rise instead turns up in the connector right after the point.
    put(row,column,'─');put(row,column+1,'─');put(row,nextColumn,'╮');
    for(let vertical=row+1;vertical<nextRow;vertical++)put(vertical,nextColumn,'│');
    put(nextRow,nextColumn,'╰');
  }
  for(let hour=0;hour<=usagePlotHours;hour+=4)put(rows[hour]!,hour*2,marker,true);
  return grid;
}
// Both series share one grid, so cells claimed by both are drawn with the heavy stroke instead of
// letting the money series silently erase the token line underneath it. The shape that carries more
// information wins the cell, otherwise a corner flattened into a straight run would break the line.
const usageShapeRank=(cell:string):number=>'●○'.includes(cell)?3:'╭╮╯╰'.includes(cell)?2:cell==='│'?1:0;
function mergeUsageSeries(tokens:string[][],money:string[][]):string[][]{
  return tokens.map((row,rowIndex)=>row.map((tokenCell,column)=>{
    const moneyCell=money[rowIndex]![column]!;
    if(moneyCell===' ')return tokenCell;
    if(tokenCell===' ')return moneyCell;
    if(tokenCell==='●'&&moneyCell==='○')return '◐';
    const shape=usageShapeRank(tokenCell)>usageShapeRank(moneyCell)?tokenCell:moneyCell;
    return boldUsageStroke[shape]??shape;
  }));
}
export function usageTimelineChart(hours:UsageHour[],timezone:string):string{
  if(hours.length!==usagePlotHours+1)throw new Error('Usage timeline must contain 25 hourly points.');
  const tokenStep=niceUsageStep(Math.max(...hours.map(hour=>hour.tokens),0));
  const moneyStep=niceUsageStep(Math.max(...hours.map(hour=>hour.costUsd),0));
  const tokenMaximum=tokenStep*usagePlotHeight,moneyMaximum=moneyStep*usagePlotHeight;
  const grid=mergeUsageSeries(drawUsageSeries(hours.map(hour=>hour.tokens),tokenMaximum,'●'),
    drawUsageSeries(hours.map(hour=>hour.costUsd),moneyMaximum,'○'));
  const leftLabels=Array.from({length:usagePlotHeight},(_,row)=>axisInteger(tokenStep*(usagePlotHeight-row)));
  const leftWidth=Math.max(1,...leftLabels.map(label=>label.length));
  const lines=[`● Токены — левая ось             ○ Деньги — правая ось`,
    '2 символа на час · точки каждые 4 часа · ━ и ◐ — серии совпадают',`${' '.repeat(leftWidth+1)}┌${'─'.repeat(usagePlotWidth)}┐`];
  for(let row=0;row<usagePlotHeight;row++)lines.push(`${leftLabels[row]!.padStart(leftWidth)} │${grid[row]!.join('')}│ `+
    axisMoney(moneyStep*(usagePlotHeight-row),moneyMaximum));
  lines.push(`${'0'.padStart(leftWidth)} └${'─'.repeat(usagePlotWidth)}┘ ${axisMoney(0,moneyMaximum)}`);
  const timeLabels=Array<string>(usagePlotWidth).fill(' ');
  for(let hour=0;hour<=usagePlotHours;hour+=4)placeLabel(timeLabels,hour*2,localHourLabel(hours[hour]!.at,timezone));
  lines.push(`${' '.repeat(leftWidth+1)}${timeLabels.join('')}`);
  const dayLabels=Array<string>(usagePlotWidth).fill(' ');placeLabel(dayLabels,2,'вчера');placeLabel(dayLabels,usagePlotWidth-4,'сегодня');
  lines.push(`${' '.repeat(leftWidth+1)}${dayLabels.join('')}`);
  const timeCaption=Array<string>(usagePlotWidth).fill(' ');placeLabel(timeCaption,Math.floor(usagePlotWidth/2),'местное время →');
  lines.push(`${' '.repeat(leftWidth+1)}${timeCaption.join('')}`);
  return lines.join('\n');
}
function compactNumber(value:number):string{return new Intl.NumberFormat('ru-RU',{notation:'compact',maximumFractionDigits:1}).format(value);}
function money(value:number):string{return `$${value<0.01?value.toFixed(6):value.toFixed(2)}`;}
function runtimeUsageText():string{
  const memory=process.memoryUsage(),cpu=process.cpuUsage(),worker=jobWorkerStatus();
  const cloud=Boolean(process.env.K_SERVICE); const service=process.env.K_SERVICE??'локальный процесс';
  const runtimeHours=process.uptime()/3600,isTaskWorker=service.includes('worker');
  const allocatedCpu=isTaskWorker?2:1,allocatedMemoryGiB=isTaskWorker?2:0.5;
  const runtime=cloud?`Cloud Run · ${service} · видимый экземпляр: 1`:'Cloud Run не активен · локальных процессов сервиса: 1';
  const allocation=cloud?`Текущий экземпляр: ${runtimeHours.toFixed(2)} instance-ч · `+
    `${(runtimeHours*allocatedCpu).toFixed(2)} vCPU-ч · ${(runtimeHours*allocatedMemoryGiB).toFixed(2)} GiB-ч`:
    'Cloud usage: 0 (локальный владелец исполнения)';
  const scaling=cloud?'web 0–2 × 20; task workers 0–3 × 1; cycle 0–1':'профиль при cutover: web 0–2 × 20; task workers 0–3 × 1; cycle 0–1';
  return `${runtime}\n${allocation}\nПамять RSS: ${Math.round(memory.rss/1_048_576)} MiB · heap: ${Math.round(memory.heapUsed/1_048_576)} MiB\n`+
    `CPU процесса: ${((cpu.user+cpu.system)/1e6).toFixed(1)} c · uptime: ${runtimeHours.toFixed(1)} ч\n`+
    `Локальный job worker: ${worker.active}/1 · очередь: ${worker.pending}/${worker.capacity}\n`+
    `AI workers: ${config.scoreAgentConcurrencyMin}–${config.scoreAgentConcurrencyMax} · масштаб: ${scaling}`;
}
function windowKeyboard():InlineKeyboard{return new InlineKeyboard()
  .text('🕒 Время уведомлений','window:time').row()
  .text('🌍 Часовой пояс','window:timezone').row()
  .text('📬 Время дайджеста','window:digest').row()
  .text('🗑 Удалить окно','window:remove');}
async function showWindowSettings(ctx:Context,userId:string):Promise<void>{
  await ctx.reply(`Настройки доставки: ${await deliverySettingsStatus(userId)}`,{reply_markup:windowKeyboard()});
}
function salary(vacancy: ScoredVacancy): string {
  if (vacancy.salaryFrom == null && vacancy.salaryTo == null) return 'не указана';
  const range = vacancy.salaryFrom != null && vacancy.salaryTo != null
    ? `${vacancy.salaryFrom.toLocaleString('ru-RU')}–${vacancy.salaryTo.toLocaleString('ru-RU')}`
    : vacancy.salaryFrom != null ? `от ${vacancy.salaryFrom.toLocaleString('ru-RU')}` : `до ${vacancy.salaryTo?.toLocaleString('ru-RU')}`;
  return `${range} ${vacancy.salaryCurrency ?? ''}${vacancy.salaryGross === false ? ' на руки' : ''}`.trim();
}

export async function sendHighScoreAlert(userId: string, vacancy: AlertVacancy): Promise<void> {
  if (!await isApprovedUser(userId)) throw new Error('User access is not approved.');
  const reasons = vacancy.reasons.slice(0, 3).map((item) => `• ${escapeHtml(item)}`).join('\n');
  const gaps = vacancy.gaps.slice(0, 2).map((item) => `• ${escapeHtml(item)}`).join('\n');
  const text = [
    `<b>${vacancy.score}/100 — ${escapeHtml(vacancy.name)}</b>`,
    `ID: <code>${escapeHtml(vacancy.applyId)}</code>`,
    `${escapeHtml(vacancy.employer)} · ${escapeHtml(vacancy.area)} · ${sourceLabel(vacancy.source)}`,
    `Направление: ${escapeHtml(vacancy.primaryTrack)} · Зарплата: ${escapeHtml(salary(vacancy))}`,
    `\n<b>Комментарий к оценке</b>\n${escapeHtml(vacancy.summary)}`,
    reasons ? `\n<b>Почему подходит</b>\n${reasons}` : '', gaps ? `\n<b>На что обратить внимание</b>\n${gaps}` : '',
  ].filter(Boolean).join('\n');
  const keyboard = new InlineKeyboard().text('Пропустить', `skip:${vacancy.id}`).text('Откликнуться', `apply:${vacancy.id}`)
    .url(`Открыть ${sourceLabel(vacancy.source)}`, vacancy.url);
  await getBot().api.sendMessage(await targetChat(userId), text, {
    parse_mode: 'HTML', reply_markup: keyboard, link_preview_options: { is_disabled: true },
  });
  await markAlerted(userId, vacancy.id);
}
function telegramRetryAfter(error:unknown):number|null{
  const value=error as {error_code?:unknown;parameters?:{retry_after?:unknown};message?:unknown};
  if(value?.error_code!==429&&!/429: Too Many Requests/i.test(String(value?.message??error)))return null;
  const seconds=Number(value?.parameters?.retry_after);return Number.isFinite(seconds)&&seconds>0?seconds:1;
}

export async function sendPendingAlerts(userId: string): Promise<number> {
  let sent = 0;
  const vacancies=await unsentHighScoreVacancies(userId, config.alertScore);
  for (const vacancy of vacancies) {
    try{await sendHighScoreAlert(userId, vacancy);sent++;}
    catch(error){
      const retryAfter=telegramRetryAfter(error);if(retryAfter==null)throw error;
      console.warn(`Telegram rate limit deferred alerts for user ${userId}; retry after ${retryAfter} seconds.`);break;
    }
    if(sent<vacancies.length)await new Promise(resolve=>setTimeout(resolve,1_100));
  }
  return sent;
}

const headerCell = (text: string, align: 'left' | 'center' | 'right'): RichBlockTableCell => ({
  text: { type: 'bold', text }, is_header: true, align, valign: 'middle',
});
const cell = (text: RichText, align: 'left' | 'center' | 'right' = 'left'): RichBlockTableCell => ({ text, align, valign: 'middle' });
function highlightedApplyId(applyId: string, allApplyIds: string[]): RichText {
  let prefixLength = 1;
  while (prefixLength < applyId.length && allApplyIds.some((other) =>
    other !== applyId && other.startsWith(applyId.slice(0, prefixLength)))) prefixLength++;
  return [{ type: 'bold', text: applyId.slice(0, prefixLength) }, applyId.slice(prefixLength)];
}
export interface DigestDeliveryOptions { scheduled?: boolean; sendEmptyTable?: boolean }
export async function sendDailyDigest(userId:string,options:DigestDeliveryOptions={}):Promise<number>{
  if(!await isApprovedUser(userId))throw new Error('User access is not approved.');
  const scheduled=options.scheduled??false,snapshotAt=new Date().toISOString();
  const settings=scheduled?await getDeliverySettings(userId):null;
  const vacancies=scheduled
    ?await digestVacancies(userId,config.digestMinScore,config.alertScore,settings?.lastDigestAt??null,snapshotAt)
    :await currentDigestVacancies(userId);
  if(!vacancies.length){
    if(options.sendEmptyTable){
      const table:InputRichBlockTable={type:'table',is_bordered:true,is_striped:true,cells:[
        [headerCell('ID','left'),headerCell('Балл','right'),headerCell('Вакансия','left'),headerCell('Ссылка','center')],
        [cell('—'),cell('—','right'),cell('Нет новых вакансий для дайджеста'),cell('—','center')],
      ]};
      await getBot().api.sendRichMessage(await targetChat(userId),{blocks:[table]},{disable_notification:true});
    }
    if(scheduled)await replaceDigestSnapshot(userId,[],snapshotAt);
    return 0;
  }
  const applyIds=vacancies.map(vacancy=>vacancy.applyId);
  for(let offset=0;offset<vacancies.length;offset+=30){
    const page=vacancies.slice(offset,offset+30);
    const table:InputRichBlockTable={
      type:'table',is_bordered:true,is_striped:true,
      cells:[[headerCell('ID','left'),headerCell('Балл','right'),headerCell('Вакансия','left'),headerCell('Ссылка','center')],
        ...page.map(vacancy=>[cell(highlightedApplyId(vacancy.applyId,applyIds)),cell(String(vacancy.score),'right'),
          cell(vacancy.name),cell({type:'url',text:'Открыть',url:vacancy.url},'center')])],
    };
    await getBot().api.sendRichMessage(await targetChat(userId),{blocks:[
      {type:'heading',size:3,text:offset?'Ежедневная подборка — продолжение':'Ежедневная подборка вакансий'},table,
      {type:'paragraph',text:'Пришлите выделенный префикс или полный ID, чтобы получить адаптированное резюме и сопроводительное письмо.'},
    ]},{disable_notification:true});
  }
  if(scheduled)await replaceDigestSnapshot(userId,vacancies.map(vacancy=>vacancy.id),snapshotAt);
  return vacancies.length;
}

const loaderFrames = ['⋆', '✦', '✧', '✶', '✷'] as const;
const loaderEditIntervalMs = 1_000;
type LoaderTask = 'Адаптирую резюме' | 'Отправляю резюме' | 'Готовлю письмо';
interface ApplicationLoader { setTask(task: LoaderTask): void; stop(): Promise<void> }
interface EditableIndicator { setLabel(label: string): void; stop(): Promise<void> }
export type CycleStatusPhase = 'scraping' | 'filtering' | 'normalization' | 'scoring';
export interface CycleStatus { set(phase: CycleStatusPhase, current?: number, total?: number): void; stop(): Promise<void> }

function retryAfterMilliseconds(error: unknown): number {
  const seconds = Number((error as { parameters?: { retry_after?: number } })?.parameters?.retry_after ?? 0);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 + 250 : 0;
}
function isUnchangedMessageError(error: unknown): boolean {
  return /message is not modified/i.test(error instanceof Error ? error.message : String(error));
}
function isMissingTelegramMessageError(error:unknown):boolean{
  return /message to edit not found|message to delete not found|message can't be edited|message_id_invalid/i
    .test(error instanceof Error?error.message:String(error));
}
/**
 * Progress indicators are transient status, not something to be woken up for: cycles run around the clock and CV
 * tailoring is already in the foreground for the user who asked. They are sent without a notification and are not
 * gated by the delivery window, which applies only to alerts and digests.
 */
async function startEditableIndicator(userId: string, initialLabel: string): Promise<EditableIndicator | null> {
  const api = getBot().api; const chat = await targetChat(userId);
  try {
    let label = initialLabel; let frame = 0; let sentText = `${loaderFrames[frame]} ${label}`;
    let updating: Promise<void> | null = null; let blockedUntil = 0; let stopped = false;let messageMissing=false;
    let timer:ReturnType<typeof setInterval>|undefined;
    const message = await api.sendMessage(chat, `<code>${sentText}</code>`,
      { parse_mode: 'HTML', disable_notification: true });
    const update = (): void => {
      const next = `${loaderFrames[frame]} ${label}`;
      if (stopped || updating || next === sentText || Date.now() < blockedUntil) return;
      updating = api.editMessageText(chat, message.message_id, `<code>${next}</code>`, { parse_mode: 'HTML' })
        .then(() => { sentText = next; }).catch((error) => {
          if(isMissingTelegramMessageError(error)){
            messageMissing=true;stopped=true;if(timer)clearInterval(timer);return;
          }
          const delay = retryAfterMilliseconds(error);
          if (delay) blockedUntil = Date.now() + delay;
          else if (!isUnchangedMessageError(error)) console.warn(`Could not edit task indicator: ${errorMessage(error)}`);
        }).finally(() => { updating = null; });
    };
    timer = setInterval(() => { frame = (frame + 1) % loaderFrames.length; update(); }, loaderEditIntervalMs);
    return {
      setLabel(nextLabel) { label = nextLabel; },
      async stop() {
        stopped = true;if(timer)clearInterval(timer); await updating;if(messageMissing)return;
        try { await api.deleteMessage(chat, message.message_id); }
        catch (error) {
          if(isMissingTelegramMessageError(error))return;
          const delay = retryAfterMilliseconds(error);
          if (!delay) { console.warn(`Could not remove task indicator: ${errorMessage(error)}`); return; }
          await new Promise((resolve) => setTimeout(resolve, delay));
          await api.deleteMessage(chat, message.message_id).catch((retryError) =>
            console.warn(`Could not remove task indicator after rate-limit retry: ${errorMessage(retryError)}`));
        }
      },
    };
  } catch (error) { console.warn(`Could not start task indicator: ${errorMessage(error)}`); return null; }
}

export async function startCycleStatus(): Promise<CycleStatus | null> {
  if (!process.env.TELEGRAM_BOT_TOKEN || !config.telegramUserId) return null;
  const indicator = await startEditableIndicator(ownerUserId(), 'Ищу вакансии');
  if (!indicator) return null;
  return {
    set(phase, current, total) {
      const label = ({ scraping: 'Ищу вакансии', filtering: 'Фильтрую', normalization: 'Обрабатываю',
        scoring: 'Оцениваю' } as const)[phase];
      indicator.setLabel(current == null || total == null ? label : `${label} (${current}/${total})`);
    },
    stop: () => indicator.stop(),
  };
}
async function startApplicationLoader(userId: string, applyId: string): Promise<ApplicationLoader | null> {
  const indicator = await startEditableIndicator(userId, `Адаптирую резюме · ${applyId}`);
  return indicator ? { setTask: (task) => indicator.setLabel(task), stop: () => indicator.stop() } : null;
}

function applicationFailureMessage(error:unknown,retryId:string):string{
  const message=error instanceof Error?error.message:String(error);
  if(/daily application-generation limit/i.test(message))return `Дневной лимит подготовки документов исчерпан. ID: ${retryId}.`;
  if(/vacancy not found|scored vacancy .* was not found/i.test(message))return `Вакансия ${retryId} больше недоступна для подготовки документов.`;
  if(/connection terminated|connection timeout|server closed the connection|socket hang up/i.test(message))
    return `Временная ошибка базы данных для вакансии ${retryId}. Пришлите ID ещё раз.`;
  return `Не удалось подготовить документы для вакансии ${retryId}. Пришлите ID ещё раз или нажмите кнопку.`;
}
async function generateAndSendApplication(userId: string, vacancyId: number, chat: string): Promise<void> {
  const jobKey = `${userId}:${vacancyId}`;
  if (applicationJobs.has(jobKey)) return;
  applicationJobs.add(jobKey); let loader: ApplicationLoader | null = null; let vacancy: ScoredVacancy | null = null;
  try {
    vacancy = await getScoredVacancy(userId, vacancyId);
    if (!vacancy) throw new Error('Vacancy not found.');
    loader = await startApplicationLoader(userId,vacancy.applyId);
    const documents = await tailorApplicationInWorker(userId, vacancyId);
    if (!await isApprovedUser(userId)) throw new Error('User access was revoked during application generation.');
    const api = getBot().api;
    loader?.setTask('Отправляю резюме');
    await api.sendDocument(chat, new InputFile(documents.tailoredCvPdf, `cv-${vacancyId}.pdf`), {
      caption: `Адаптированное резюме — ${vacancy.name}`.slice(0, 1024),
    });
    if (!await isApprovedUser(userId)) throw new Error('User access was revoked during application delivery.');
    loader?.setTask('Готовлю письмо');
    await api.sendMessage(chat, documents.coverLetter, { link_preview_options: { is_disabled: true } });
    await markApplicationDelivered(userId, vacancyId); await loader?.stop();
  } catch (error) {
    await loader?.stop().catch((stopError)=>console.warn(`Could not stop application indicator: ${errorMessage(stopError)}`));
    console.error(`Application generation failed: ${errorMessage(error)}`);
    const keyboard = new InlineKeyboard().text('Попробовать снова', `apply:${vacancyId}`)
      .url(`Открыть ${sourceLabel(vacancy?.source ?? '')}`, vacancy?.url ?? 'https://hh.ru');
    const retryId=vacancy?.applyId??String(vacancyId);
    await getBot().api.sendMessage(chat, applicationFailureMessage(error,retryId),
      { reply_markup: keyboard }).catch((notificationError)=>
      console.error(`Could not send application failure notice: ${errorMessage(notificationError)}`));
  } finally {
    applicationJobs.delete(jobKey); clearApplicationArtifacts(userId, vacancyId);
  }
}
async function runApplication(userId:string,vacancyId:number,chat:string):Promise<void>{
  const task=generateAndSendApplication(userId,vacancyId,chat);
  if(config.telegramMode==='webhook'){await task;return;}
  void task.catch((error)=>console.error(`Detached application task failed: ${errorMessage(error)}`));
}

async function cvStatus(userId: string): Promise<string> {
  const cv = await getCvSource(userId);
  return cv ? 'Резюме загружено' : 'Резюме не загружено';
}
async function downloadTelegramFile(fileId: string, declaredSize?: number): Promise<Uint8Array> {
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
async function refreshSearchesAfterCvUpload(userId: string): Promise<void> {
  const cvHash = await getCvHash(userId);
  if (!cvHash) return;
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
          const refreshed = await refreshUserInWorker(userId, requestedHash);
          if (!pendingRefreshHashes.has(userId) && await isApprovedUser(userId) && await getCvHash(userId) === requestedHash) {
            await getBot().api.sendMessage(await targetChat(userId),
              `Готово: создано ${refreshed.searchCount} поисковых запросов для ${refreshed.platformCount} платформ. ` +
              'Они будут использованы в следующем цикле поиска.');
          }
        } catch (error) {
          if (!pendingRefreshHashes.has(userId) && await isApprovedUser(userId) && await getCvHash(userId)) {
            console.error(`Search-profile refresh failed for user ${userId}`,
              error instanceof Error ? error.message : String(error));
            await getBot().api.sendMessage(await targetChat(userId),
              'Резюме сохранено, но поисковые настройки пока не удалось обновить. Бот повторит попытку в следующем цикле, когда позволит лимит.');
          }
        }
      }
    } finally {
      pendingRefreshHashes.delete(userId);
      refreshingUsers.delete(userId);
    }
  })();
}

function userPrefix(userId: string, pageIds: string[]): string {
  let length = 1;
  while (length < userId.length && pageIds.some((other) => other !== userId && other.startsWith(userId.slice(0, length)))) length++;
  return userId.slice(0, length);
}
async function usersPage(pageInput: number): Promise<{ richMessage: InputRichMessage; keyboard: InlineKeyboard; ids: string[]; page: number }> {
  const total = (await listTelegramUsers(1, 0)).total; const pages = Math.max(1, Math.ceil(total / usersPageSize));
  const page = Math.max(0, Math.min(pageInput, pages - 1)); const { users } = await listTelegramUsers(usersPageSize, page * usersPageSize);
  const ids = users.map((user) => user.userId);
  const userRows = await Promise.all(users.map(async (user) => {
    const ref = user.isOwner ? '—' : userPrefix(user.userId, ids);
    const name = (user.username ? `@${user.username}` : user.displayName).replace(/\s+/g, ' ').slice(0, 24);
    return [cell(ref), cell(`${name}\n${user.userId}`), cell(userStatusText(user.status)),
      cell(await getCvSource(user.userId) ? 'да' : 'нет', 'center'), cell(await deliverySettingsStatus(user.userId))];
  }));
  const table: InputRichBlockTable = {
    type: 'table', is_bordered: true, is_striped: true,
    cells: [[headerCell('Ссылка', 'left'), headerCell('Пользователь', 'left'), headerCell('Статус', 'left'),
      headerCell('CV', 'center'), headerCell('Доставка', 'left')], ...userRows],
  };
  const richMessage: InputRichMessage = { blocks: [
    { type: 'heading', size: 3, text: `Пользователи — страница ${page + 1}/${pages}` },
    table,
    { type: 'paragraph', text: 'Одобрить: /ok ID или @username. Отозвать: /revoke ССЫЛКА.' },
  ] };
  const keyboard = new InlineKeyboard();
  if (page > 0) keyboard.text('‹ Назад', `users-page:${page - 1}`);
  if (page + 1 < pages) keyboard.text('Далее ›', `users-page:${page + 1}`);
  return { richMessage, keyboard, ids, page };
}
/**
 * Repeatable owner commands replace their own previous output instead of stacking: the old command message and its
 * answer are removed before the new answer is sent. Telegram refuses to delete messages older than about 48 hours,
 * so the record is kept only that long and failures are ignored.
 */
const transientMessageTtlMs = 47 * 60 * 60 * 1_000;
async function dropTrackedMessages(userId: string, kind: string): Promise<void> {
  const stored = await getTelegramSession<{ ids: number[] }>(userId, kind);
  if (!stored?.ids?.length) return;
  const chat = await targetChat(userId);
  for (const id of stored.ids) await getBot().api.deleteMessage(chat, id).catch(() => undefined);
  await deleteTelegramSession(userId, kind).catch(() => undefined);
}
async function trackMessages(userId: string, kind: string, ids: (number | undefined)[]): Promise<void> {
  const present = ids.filter((id): id is number => typeof id === 'number');
  if (present.length) await setTelegramSession(userId, kind, { ids: present }, transientMessageTtlMs);
}

async function showUsers(ctx: Context, page: number, edit = false): Promise<number | undefined> {
  const view = await usersPage(page); latestUserPages.set(ownerUserId(), view.ids);
  const options = { reply_markup: view.keyboard };
  // Paging edits the existing message, so its id stays valid and stays tracked.
  if (edit) { await ctx.editMessageText(view.richMessage, options); return undefined; }
  return (await ctx.replyWithRichMessage(view.richMessage, options)).message_id;
}
async function resolveUserReference(reference: string): Promise<TelegramUser | null> {
  const pageIds = latestUserPages.get(ownerUserId()) ?? [];
  const pageMatches = pageIds.filter((id) => id === reference || id.startsWith(reference));
  if (pageMatches.length === 1) return getTelegramUser(pageMatches[0]);
  const all = (await listTelegramUsers(10_000, 0)).users.filter((user) => user.userId === reference || user.userId.startsWith(reference));
  return all.length === 1 ? all[0]! : null;
}
async function resolveApprovalReference(reference: string): Promise<TelegramUser | null> {
  const value = reference.trim(); const username = value.replace(/^@/, '').toLowerCase();
  const matches = (await listTelegramUsers(10_000, 0)).users.filter((user) =>
    user.userId === value || user.username?.toLowerCase() === username);
  return matches.length === 1 ? matches[0]! : null;
}
async function deletePersonalData(ctx: Context, confirmation: string): Promise<void> {
  if (!ctx.from) return;
  const userId = String(ctx.from.id);
  if (confirmation.trim().toLowerCase() !== 'confirm') {
    await ctx.reply('Это навсегда удалит ваше резюме, поисковые настройки, оценки, решения, отклики, статистику и настройки доставки. ' +
      'Общая база вакансий останется. Для подтверждения отправьте /delete_me confirm.');
    return;
  }
  if ([...applicationJobs].some((key) => key.startsWith(`${userId}:`)) || activeCvImports.has(userId)
    || refreshingUsers.has(userId)) {
    await ctx.reply('Сейчас выполняется задача с вашим резюме или откликом. Дождитесь её завершения и повторите удаление.'); return;
  }
  await Promise.all(['cv-upload', 'cv-cooldown', 'window-setup'].map((kind) => deleteTelegramSession(userId, kind)));
  pendingRefreshHashes.delete(userId);
  await deleteUserData(userId);
  await ctx.reply('Ваши персональные данные удалены. Доступ к боту сохранён — загрузить новое резюме можно командой /cv.');
}

async function approvedStartText(user: TelegramUser): Promise<string> {
  const ownerCommands = user.isOwner
    ? '\n\nКоманды владельца:\n/ok ID или @username — одобрить доступ\n/users — пользователи\n/revoke ССЫЛКА — отозвать доступ\n/usage — статистика использования'
    : '';
  return `Доступ открыт.\n\n1. Загрузите актуальное резюме командой /cv.\n` +
    `2. Настройте время уведомлений и дайджеста командой /window.\n` +
    `3. Бот будет искать вакансии и оценивать их по вашему резюме.\n\n` +
    `Поиск по найденным вакансиям: /search запрос\nЭкспорт данных: /export_me\nУдаление данных: /delete_me\n` +
    `Как обрабатываются данные: /privacy\n\n${await cvStatus(user.userId)}\nДоставка: ${await deliverySettingsStatus(user.userId)}` + ownerCommands;
}

function configureTelegramBot(): Bot | null {
  if (!process.env.TELEGRAM_BOT_TOKEN) return null;
  const instance = getBot();
  if (botConfigured) return instance;
  const ownerId = ownerUserId();
  if (config.telegramChatId && config.telegramChatId !== ownerId) {
    throw new Error('TELEGRAM_CHAT_ID must be the owner private-chat ID and match TELEGRAM_USER_ID.');
  }
  instance.use(async (ctx, next) => {
    const currentIdentity = identity(ctx);
    if (!currentIdentity) return;
    const user = await touchTelegramUser(currentIdentity);
    const command = ctx.message?.text?.match(/^\/(\w+)/)?.[1]?.toLowerCase();
    if (user.status === 'approved' || user.isOwner || command === 'start' || command === 'request') await next();
    else await ctx.reply(`Доступ: ${userStatusText(user.status)}. Отправьте /request, чтобы запросить доступ у владельца бота.`);
  });
  instance.command('start', async (ctx) => {
    const currentIdentity = identity(ctx); if (!currentIdentity) return;
    const user = await getTelegramUser(currentIdentity.userId);
    if (!user) throw new Error('Telegram user was not persisted.');
    if (user.status === 'approved') await ctx.reply(await approvedStartText(user));
    else await ctx.reply(`Это приватный бот для поиска вакансий. Доступ подтверждает владелец.\n\n` +
      `Ваш статус: ${userStatusText(user.status)}. Отправьте /request, чтобы подать заявку.`);
  });
  instance.command('request', async (ctx) => {
    const currentIdentity = identity(ctx); if (!currentIdentity) return;
    const request = await requestAccess(currentIdentity); const { user } = request;
    if (user.isOwner || user.status === 'approved') { await ctx.reply('У вас уже есть доступ. Отправьте /start, чтобы продолжить.'); return; }
    if (request.retryAfterSeconds > 0) {
      const minutes = Math.max(1, Math.ceil(request.retryAfterSeconds / 60));
      await ctx.reply(`Повторную заявку можно отправить через ${minutes} мин.`); return;
    }
    if (!request.notifyOwner) { await ctx.reply('Заявка уже отправлена и ждёт решения владельца.'); return; }
    const keyboard = new InlineKeyboard().text('Одобрить', `access:approve:${user.userId}`).text('Отклонить', `access:reject:${user.userId}`);
    await getBot().api.sendMessage(await targetChat(ownerUserId()),
      `<b>Новая заявка на доступ</b>\n${escapeHtml(user.displayName)}${user.username ? ` (@${escapeHtml(user.username)})` : ''}\n` +
      `ID пользователя: <code>${user.userId}</code>`, { parse_mode: 'HTML', reply_markup: keyboard });
    await ctx.reply('Заявка отправлена. Бот сообщит, когда владелец примет решение.');
  });
  instance.callbackQuery(/^access:(approve|reject):(\d+)$/, async (ctx) => {
    if (String(ctx.from.id) !== ownerUserId()) { await ctx.answerCallbackQuery({ text: 'Только для владельца' }); return; }
    const action = ctx.match[1]; const userId = ctx.match[2];
    const current = await getTelegramUser(userId);
    if (!current) { await ctx.answerCallbackQuery({ text: 'Пользователь не найден' }); return; }
    if (current.status !== 'pending') {
      await ctx.answerCallbackQuery({ text: `Заявка уже обработана: ${userStatusText(current.status)}` });
      await ctx.deleteMessage().catch(() => undefined);
      return;
    }
    const user = await setUserStatus(userId, action === 'approve' ? 'approved' : 'rejected');
    if (!user) throw new Error('Telegram user disappeared during access update.');
    await ctx.answerCallbackQuery({ text: action === 'approve' ? 'Доступ одобрен' : 'Заявка отклонена' });
    // The decision is confirmed by the callback toast, so the spent request card is removed rather than left behind.
    await ctx.deleteMessage().catch(() => undefined);
    await getBot().api.sendMessage(user.chatId, action === 'approve'
      ? 'Доступ одобрен. Отправьте /start, чтобы начать настройку.'
      : 'Заявка отклонена. Позже вы сможете снова отправить /request.');
  });
  instance.command('ok', async (ctx) => {
    if (String(ctx.from?.id) !== ownerUserId()) { await ctx.reply('Эта команда доступна только владельцу.'); return; }
    const reference = ctx.match.trim();
    if (!reference) { await ctx.reply('Укажите ID или username: /ok 123456789 или /ok @username'); return; }
    const user = await resolveApprovalReference(reference);
    if (!user) { await ctx.reply('Пользователь не найден. Он должен сначала открыть бота или отправить /request.'); return; }
    if (user.isOwner || user.status === 'approved') { await ctx.reply('У этого пользователя уже есть доступ.'); return; }
    await setUserStatus(user.userId, 'approved');
    await ctx.reply(`Доступ одобрен: ${user.username ? `@${user.username}` : user.userId}.`);
    try { await getBot().api.sendMessage(user.chatId, 'Доступ одобрен. Отправьте /start, чтобы начать настройку.'); }
    catch (error) {
      console.error(`Could not notify approved user ${user.userId}: ${errorMessage(error)}`);
      await ctx.reply('Доступ сохранён, но уведомить пользователя не удалось.');
    }
  });
  instance.command('users', async (ctx) => {
    if (String(ctx.from?.id) !== ownerUserId()) { await ctx.reply('Эта команда доступна только владельцу.'); return; }
    await dropTrackedMessages(ownerUserId(), 'users-messages');
    const page = Math.max(0, Number.parseInt(ctx.match.trim(), 10) - 1 || 0);
    const sent = await showUsers(ctx, page);
    await trackMessages(ownerUserId(), 'users-messages', [ctx.message?.message_id, sent]);
  });
  instance.callbackQuery(/^users-page:(\d+)$/, async (ctx) => {
    if (String(ctx.from.id) !== ownerUserId()) { await ctx.answerCallbackQuery({ text: 'Только для владельца' }); return; }
    await ctx.answerCallbackQuery(); await showUsers(ctx, Number(ctx.match[1]), true);
  });
  instance.command('revoke', async (ctx) => {
    if (String(ctx.from?.id) !== ownerUserId()) { await ctx.reply('Эта команда доступна только владельцу.'); return; }
    const reference = ctx.match.trim();
    if (!reference) { await ctx.reply('Сначала откройте /users, затем отправьте /revoke ССЫЛКА.'); return; }
    const user = await resolveUserReference(reference);
    if (!user) { await ctx.reply('Ссылка не найдена или неоднозначна. Откройте /users и используйте ссылку из таблицы.'); return; }
    if (user.isOwner) { await ctx.reply('Нельзя отозвать доступ у владельца.'); return; }
    await setUserStatus(user.userId, 'revoked');
    await Promise.all(['cv-upload', 'window-setup'].map((kind) => deleteTelegramSession(user.userId, kind)));
    pendingRefreshHashes.delete(user.userId);
    await ctx.reply(`Доступ пользователя ${user.userId} отозван.`);
    await getBot().api.sendMessage(user.chatId, 'Ваш доступ к боту отозван. Позже можно снова отправить /request.');
  });
  instance.command('usage', async (ctx) => {
    if (String(ctx.from?.id) !== ownerUserId()) { await ctx.reply('Эта команда доступна только владельцу.'); return; }
    const [rows,llm,settings]=await Promise.all([userUsageSummaries(),llmUsageSummary(),getDeliverySettings(ownerUserId())]);
    const lines = rows.map((row) => `${row.userId.padEnd(14)} ${String(row.scores24h).padStart(4)}/${String(row.scoresTotal).padEnd(5)} ` +
      `${String(row.applications24h).padStart(3)}/${String(row.applicationsTotal).padEnd(4)} ${row.displayName.slice(0, 18)}`);
    const chart=usageTimelineChart(llm.hourlyTimeline,settings?.timezone??config.timezone);
    await dropTrackedMessages(ownerUserId(), 'usage-messages');
    const sent = await ctx.reply(`<b>Использование — 24 часа / всё время</b>\n`+
      `LLM-вызовы: <b>${llm.turns24h} / ${llm.turnsTotal}</b>\n`+
      `Токены: <b>${compactNumber(llm.tokens24h)} / ${compactNumber(llm.tokensTotal)}</b>\n`+
      `Стоимость модели: <b>${money(llm.cost24hUsd)} / ${money(llm.costTotalUsd)}</b>\n\n`+
      `<b>Почасовая динамика за 24 часа</b>\n<pre>${escapeHtml(chart)}</pre>\n`+
      `<b>Ресурсы и масштабирование</b>\n<pre>${escapeHtml(runtimeUsageText())}</pre>\n`+
      `<b>Пользователи</b>\n<pre>${escapeHtml(['ID              Оценки      Отклики  Пользователь', ...lines].join('\n'))}</pre>`,
      { parse_mode: 'HTML' });
    await trackMessages(ownerUserId(), 'usage-messages', [ctx.message?.message_id, sent.message_id]);
  });
  instance.command('search', async (ctx) => {
    const query = ctx.match.trim();
    if (!query) { await ctx.reply('Добавьте запрос после команды: /search должность, компания или навык'); return; }
    const results = await searchScoredVacancies(String(ctx.from!.id), query);
    if (!results.length) { await ctx.reply('В оценённых вакансиях ничего не найдено. Попробуйте другие слова.'); return; }
    const text = results.map((vacancy) => `<b>${vacancy.score}/100 — ${escapeHtml(vacancy.name)}</b>\n` +
      `${escapeHtml(vacancy.employer)} · <code>${vacancy.applyId}</code> · <a href="${escapeHtml(vacancy.url)}">открыть</a>`).join('\n\n');
    await ctx.reply(text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  });
  instance.command('export_me', async (ctx) => {
    const userId = String(ctx.from!.id);
    const bytes = Buffer.from(`${JSON.stringify(await exportUserData(userId), null, 2)}\n`);
    await ctx.replyWithDocument(new InputFile(bytes, `jobseeker-export-${new Date().toISOString().slice(0, 10)}.json`));
  });
  instance.command('delete_me', async (ctx) => deletePersonalData(ctx, ctx.match));
  instance.hears(/^\/delete-me(?:@\w+)?(?:\s+(.*))?$/i, async (ctx) => deletePersonalData(ctx, ctx.match[1] ?? ''));
  instance.command('window', async (ctx) => {
    const userId=String(ctx.from!.id);await deleteTelegramSession(userId,'window-setup');await showWindowSettings(ctx,userId);
  });
  instance.callbackQuery(/^window:(time|timezone|digest|remove)$/,async(ctx)=>{
    const userId=String(ctx.from.id),action=ctx.match[1];await ctx.answerCallbackQuery();
    await deleteTelegramSession(userId,'window-setup');
    if(action==='remove'){
      await removeDeliveryWindow(userId);await ctx.reply(`Окно уведомлений удалено. ${await deliverySettingsStatus(userId)}`,
        {reply_markup:windowKeyboard()});return;
    }
    if(action==='time'){
      await setTelegramSession(userId,'window-setup',{step:'start'} satisfies WindowSetup,windowSetupTtlMs);
      await ctx.reply('Во сколько начинать уведомления? Отправьте время ЧЧ:ММ, например 09:00.');return;
    }
    if(action==='timezone'){
      await setTelegramSession(userId,'window-setup',{step:'timezone'} satisfies WindowSetup,windowSetupTtlMs);
      await ctx.reply('Укажите смещение от UTC: например +3, -5 или +3:30.');return;
    }
    await setTelegramSession(userId,'window-setup',{step:'digest'} satisfies WindowSetup,windowSetupTtlMs);
    await ctx.reply('Во сколько присылать ежедневную подборку? Отправьте время ЧЧ:ММ, например 09:30.');
  });
  instance.command('digest',async(ctx)=>{
    await sendDailyDigest(String(ctx.from!.id),{sendEmptyTable:true});
  });
  instance.on('message:text', async (ctx, next) => {
    const userId = String(ctx.from.id); const setup = await getTelegramSession<WindowSetup>(userId, 'window-setup');
    if (!setup) { await next(); return; }
    const value = ctx.message.text.trim();
    try {
      if (setup.step === 'start') {
        parseClockMinutes(value); await setTelegramSession(userId, 'window-setup', { step: 'end', start: value } satisfies WindowSetup, windowSetupTtlMs);
        await ctx.reply('Во сколько заканчивать уведомления? Отправьте время ЧЧ:ММ, например 22:00.');
      } else if (setup.step === 'end') {
        await updateDeliveryWindow(userId,setup.start!,value);await deleteTelegramSession(userId,'window-setup');
        await ctx.reply(`Время уведомлений сохранено. ${await deliverySettingsStatus(userId)}`,{reply_markup:windowKeyboard()});
      } else if (setup.step === 'digest') {
        await updateDigestTime(userId,value);await deleteTelegramSession(userId,'window-setup');
        await ctx.reply(`Время дайджеста сохранено. ${await deliverySettingsStatus(userId)}`,{reply_markup:windowKeyboard()});
      } else {
        await updateDeliveryTimezone(userId,normalizeUtcOffset(value));await deleteTelegramSession(userId,'window-setup');
        await ctx.reply(`Часовой пояс сохранён. ${await deliverySettingsStatus(userId)}`,{reply_markup:windowKeyboard()});
      }
    } catch (error) { await ctx.reply(error instanceof Error ? error.message : String(error)); }
  });
  instance.command('privacy', async (ctx) => {
    await ctx.reply('Как обрабатываются данные:\n\n• В приватной базе хранятся текст и структура резюме, поисковые настройки, числовые оценки, статистика и состояние доставки.\n• Текст резюме и вакансий передаётся настроенной языковой модели для поиска, оценки и подготовки отклика.\n• Исходные файлы, готовые PDF, сопроводительные письма и завершённые диалоги с моделью не сохраняются.\n• Пояснение к высокой оценке хранится только до отправки уведомления.\n• Экспорт: /export_me. Полное удаление: /delete_me confirm.\n\nЗагружая резюме через /cv, вы соглашаетесь с этой обработкой.');
  });
  instance.command('cv', async (ctx) => {
    const userId = String(ctx.from!.id);
    if (ctx.match.trim()) { await ctx.reply('Просто отправьте команду /cv без дополнительных параметров.'); return; }
    if (!await getTelegramSession(userId, 'cv-upload')) {
      const cooldownMs = config.cvUploadSessionCooldownMinutes * 60_000;
      const cooldown = await claimTelegramSession(userId, 'cv-cooldown', {}, cooldownMs);
      if (!cooldown.claimed) {
        const remaining = cooldown.expiresAt.getTime() - Date.now();
        await ctx.reply(`Новую загрузку можно начать через ${Math.max(1, Math.ceil(remaining / 60_000))} мин.`);
        return;
      }
    }
    await setTelegramSession(userId, 'cv-upload', {}, cvUploadSessionTtlMs);
    await ctx.reply(`${await cvStatus(userId)}.\n\nПришлите актуальное резюме одним файлом: PDF, Markdown, TXT или DOCX до 20 МБ. ` +
      'Новое резюме заменит предыдущее. Загружая файл, вы соглашаетесь с условиями /privacy.');
  });
  instance.on('message:document', async (ctx) => {
    const userId = String(ctx.from.id);
    if (!await getTelegramSession(userId, 'cv-upload')) { await ctx.reply('Сначала отправьте /cv, затем прикрепите файл с резюме.'); return; }
    if (activeCvImports.has(userId)) { await ctx.reply('Предыдущий файл ещё проверяется. Пожалуйста, подождите.'); return; }
    activeCvImports.add(userId);
    try {
      const document = ctx.message.document;
      const filename = document.file_name ?? 'cv';
      if (document.file_size != null && document.file_size > maximumCvBytes) {
        await ctx.reply('Файл больше 20 МБ. Пришлите файл меньшего размера.'); return;
      }
      const supportedExtension = /\.(?:pdf|md|markdown|txt|docx)$/i.test(filename);
      const unsupportedExtension = /\.[a-z0-9]{1,10}$/i.test(filename) && !supportedExtension;
      const supportedMediaType = ['application/pdf', 'text/markdown', 'text/plain',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(document.mime_type ?? '');
      if (unsupportedExtension || (!supportedExtension && !supportedMediaType)) {
        await ctx.reply('Поддерживаются только PDF, Markdown, TXT и DOCX.'); return;
      }
      const bytes = await downloadTelegramFile(document.file_id, document.file_size);
      await importCvSource(userId, filename, document.mime_type, bytes);
      await deleteTelegramSession(userId, 'cv-upload');
      await ctx.reply(`Резюме сохранено. ${await cvStatus(userId)}.\nОбновляю настройки поиска…`);
      await refreshSearchesAfterCvUpload(userId);
    } catch (error) {
      console.error(`CV import failed for user ${userId}: ${errorMessage(error)}`);
      if (await isApprovedUser(userId)) await ctx.reply('Не удалось обработать файл. Проверьте формат и размер, затем попробуйте снова.');
    } finally { activeCvImports.delete(userId); }
  });
  instance.hears(/^\s*([a-zA-Z]{1,6})\s*$/, async (ctx) => {
    if (!ctx.from) return;
    const userId = String(ctx.from.id); const reference = ctx.match[1].toLowerCase();
    const exact = reference.length === 6 ? await getScoredVacancyByApplyId(userId, reference) : null;
    const matches: ScoredVacancy[] = reference.length === 6 ? (exact ? [exact] : [])
      : await latestDigestVacanciesByApplyIdPrefix(userId, reference);
    if (!matches.length) { await ctx.reply(`В последней подборке нет вакансии с ID ${reference}.`); return; }
    if (matches.length > 1) { await ctx.reply(`Префикс ${reference} подходит к нескольким вакансиям. Пришлите больше букв.`); return; }
    const vacancy = matches[0]; const key = `${userId}:${vacancy.id}`;
    if (applicationJobs.has(key)) { await ctx.reply(`Документы для ${vacancy.applyId} уже готовятся.`); return; }
    await runApplication(userId,vacancy.id,String(ctx.chat?.id??ctx.from.id));
  });
  instance.callbackQuery(/^skip:(\d+)$/, async (ctx) => {
    const userId = String(ctx.from.id); const id = Number(ctx.match[1]); await skipVacancy(userId, id);
    await ctx.answerCallbackQuery({ text: 'Вакансия пропущена' }); await ctx.deleteMessage();
  });
  instance.callbackQuery(/^apply:(\d+)$/, async (ctx) => {
    const userId = String(ctx.from.id); const id = Number(ctx.match[1]);
    await ctx.answerCallbackQuery({ text: 'Готовлю резюме и письмо…' });
    const vacancy = await getScoredVacancy(userId, id);
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard()
      .url(`Открыть ${sourceLabel(vacancy?.source ?? '')}`, vacancy?.url ?? 'https://hh.ru') });
    await runApplication(userId,id,String(ctx.chat?.id??ctx.from.id));
  });
  instance.catch((error) => console.error(`Telegram bot error: ${errorMessage(error.error)}`));
  botConfigured = true;
  return instance;
}

async function registerTelegramCommands(instance: Bot): Promise<void> {
  await instance.api.deleteMyCommands();
  await instance.api.setMyCommands([
    { command: 'start', description: 'Начало работы и статус' },
    { command: 'request', description: 'Запросить доступ' },
    { command: 'cv', description: 'Загрузить или заменить резюме' },
    { command: 'privacy', description: 'Как обрабатываются данные' },
    { command: 'window', description: 'Настроить время уведомлений' },
    { command: 'digest', description: 'Состояние ежедневного дайджеста' },
    { command: 'search', description: 'Поиск по оценённым вакансиям' },
    { command: 'export_me', description: 'Экспортировать свои данные' },
    { command: 'delete_me', description: 'Удалить свои данные' },
  ]);
}

export function startTelegramBot(): void {
  const instance = configureTelegramBot();
  if (!instance || config.telegramMode !== 'polling') return;
  void instance.start({ allowed_updates: ['message', 'callback_query'], onStart: async () => {
    await registerTelegramCommands(instance);
    console.info('Telegram bot started; multi-user commands registered');
  } });
}

export async function initializeTelegramWebhookHandler(): Promise<void> {
  if (config.telegramMode !== 'webhook') return;
  const instance = configureTelegramBot();
  if (!instance) throw new Error('TELEGRAM_BOT_TOKEN is required for webhook mode.');
  await instance.init();
}

export async function handleTelegramWebhookUpdate(update: unknown): Promise<void> {
  if (config.telegramMode !== 'webhook') throw new Error('Telegram webhook mode is not enabled.');
  const instance = configureTelegramBot();
  if (!instance) throw new Error('TELEGRAM_BOT_TOKEN is required for webhook mode.');
  if (!instance.botInfo) await instance.init();
  await instance.handleUpdate(update as Parameters<Bot['handleUpdate']>[0]);
}

export async function initializeTelegramWebhookMode(): Promise<void> {
  await initializeTelegramWebhookHandler();
  if (config.telegramMode !== 'webhook') return;
  const instance = configureTelegramBot()!;
  await registerTelegramCommands(instance);
  console.info('Telegram webhook handlers initialized; multi-user commands registered');
}

export async function stopTelegramBot(): Promise<void> {
  if (bot?.isRunning()) await bot.stop();
}
