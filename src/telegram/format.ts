import { InlineKeyboard } from 'grammy';
import { type RichBlockTableCell, type RichText } from 'grammy/types';
import { config } from '../config.ts';
import { type ScoredVacancy, type ScraperHour, type ScraperSummary, type TelegramUser, type UsageHour } from '../postgres.ts';
import { getSearchPlatform } from '../vacancies/registry.ts';
import { jobWorkerStatus } from '../worker-client.ts';
import { type ApplicationArtifact } from '../postgres.ts';
import { engineLoopStatus } from '@jobseeker/engine';


export function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
const sourceLabels: Record<string, string> = {
  hh: 'HH', habr: 'Habr Career', rabota: 'Работа.ру', hirehi: 'HireHi',
  geekjob: 'GeekJob', avito: 'Avito', trudvsem: 'Работа России', ats: 'ATS-борды компаний',
};
export function sourceLabel(source: string): string {
  return sourceLabels[source] ?? 'источник';
}
// Search profiles are shown per platform, so an unlabelled platform falls back to its registry name instead of
// the placeholder used for alert buttons.
export function platformLabel(platformId: string): string {
  return sourceLabels[platformId] ?? getSearchPlatform(platformId).name;
}
export function userStatusText(status: TelegramUser['status']): string {
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
interface TimelinePoint{at:string;left:number;right:number}
function timelineChart(points:TimelinePoint[],legend:string,rightAxis:(value:number,maximum:number)=>string,
  timezone:string):string{
  if(points.length!==usagePlotHours+1)throw new Error('Timeline must contain 25 hourly points.');
  const leftStep=niceUsageStep(Math.max(...points.map(point=>point.left),0));
  const rightStep=niceUsageStep(Math.max(...points.map(point=>point.right),0));
  const leftMaximum=leftStep*usagePlotHeight,rightMaximum=rightStep*usagePlotHeight;
  const grid=mergeUsageSeries(drawUsageSeries(points.map(point=>point.left),leftMaximum,'●'),
    drawUsageSeries(points.map(point=>point.right),rightMaximum,'○'));
  const leftLabels=Array.from({length:usagePlotHeight},(_,row)=>axisInteger(leftStep*(usagePlotHeight-row)));
  const leftWidth=Math.max(1,...leftLabels.map(label=>label.length));
  const lines=[legend,
    '2 символа на час · точки каждые 4 часа · ━ и ◐ — серии совпадают',`${' '.repeat(leftWidth+1)}┌${'─'.repeat(usagePlotWidth)}┐`];
  for(let row=0;row<usagePlotHeight;row++)lines.push(`${leftLabels[row]!.padStart(leftWidth)} │${grid[row]!.join('')}│ `+
    rightAxis(rightStep*(usagePlotHeight-row),rightMaximum));
  lines.push(`${'0'.padStart(leftWidth)} └${'─'.repeat(usagePlotWidth)}┘ ${rightAxis(0,rightMaximum)}`);
  const timeLabels=Array<string>(usagePlotWidth).fill(' ');
  for(let hour=0;hour<=usagePlotHours;hour+=4)placeLabel(timeLabels,hour*2,localHourLabel(points[hour]!.at,timezone));
  lines.push(`${' '.repeat(leftWidth+1)}${timeLabels.join('')}`);
  const dayLabels=Array<string>(usagePlotWidth).fill(' ');placeLabel(dayLabels,2,'вчера');placeLabel(dayLabels,usagePlotWidth-4,'сегодня');
  lines.push(`${' '.repeat(leftWidth+1)}${dayLabels.join('')}`);
  const timeCaption=Array<string>(usagePlotWidth).fill(' ');placeLabel(timeCaption,Math.floor(usagePlotWidth/2),'местное время →');
  lines.push(`${' '.repeat(leftWidth+1)}${timeCaption.join('')}`);
  return lines.join('\n');
}
export function usageTimelineChart(hours:UsageHour[],timezone:string):string{
  return timelineChart(hours.map(hour=>({at:hour.at,left:hour.tokens,right:hour.costUsd})),
    `● Токены — левая ось             ○ Деньги — правая ось`,axisMoney,timezone);
}
export function scraperTimelineChart(hours:ScraperHour[],timezone:string):string{
  return timelineChart(hours.map(hour=>({at:hour.at,left:hour.scored,right:hour.normalized})),
    `● Оценки — левая ось          ○ Распознано — правая ось`,(value)=>axisInteger(value),timezone);
}
/**
 * The scraper's day at a glance for the owner: what each adapter brought in, what the parser made of it, how the
 * scheduler is pacing the units, and what is failing — a dead adapter shows as a zero row, never as absence.
 */
export function scraperStatusMessage(summary:ScraperSummary):string{
  const lines=['<b>Скрейпер и парсер — 24 часа</b>',
    `Листинги: <b>${summary.sources.reduce((total,row)=>total+row.discovered24h,0)}</b> новых · `+
    `распознано: <b>${summary.sources.reduce((total,row)=>total+row.normalized24h,0)}</b> · `+
    `очередь: ${summary.sources.reduce((total,row)=>total+row.queued,0)}`,
    `Матчи: <b>${summary.matched24h}</b> · оценки: <b>${summary.scored24h}</b>`,'',
    '<b>По источникам</b>'];
  for(const row of summary.sources){
    lines.push(`• ${escapeHtml(row.source)}: ${row.discovered24h} новых · ${row.normalized24h} распознано · `+
      `очередь ${row.queued} · сбоев ${row.failed} · закрыто ${row.closed24h} · оценок ${row.scored24h}`);
  }
  lines.push('','<b>Поисковые юниты</b>');
  for(const row of summary.units){
    const novelty=row.lastNoveltyAt?`новизна ${Math.round((Date.now()-Date.parse(row.lastNoveltyAt))/3_600_000)} ч назад`:'новизны не было';
    lines.push(`• ${escapeHtml(row.platform)}: ${row.units} юнитов · просрочено ${row.overdue} · `+
      `каденция ${row.cadenceMin}–${row.cadenceMax} мин · ${novelty}`);
  }
  if(summary.errors.length){
    lines.push('','<b>Ошибки парсера за 24 часа</b>');
    for(const row of summary.errors)lines.push(`• ${escapeHtml(row.error)} ×${row.count}`);
  }
  return lines.join('\n');
}
export function compactNumber(value:number):string{return new Intl.NumberFormat('ru-RU',{notation:'compact',maximumFractionDigits:1}).format(value);}
export function money(value:number):string{return `$${value<0.01?value.toFixed(6):value.toFixed(2)}`;}
// The next cycle is announced in the schedule's own timezone, because a UTC instant says nothing about when the
// owner should expect the run.
function scheduleClock(timestamp:string,timezone:string):string{
  try{
    return new Intl.DateTimeFormat('ru-RU',{timeZone:timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'})
      .format(new Date(timestamp));
  }catch{return timestamp;}
}
// Deployment answers "where and how is this running": which Cloud Run revision serves the command, what it is
// allowed to consume, who owns the scheduled cycle and where background work is dispatched. Model spend lives in
// /usage instead, so the two commands never repeat each other.
export function deploymentStatusText():string{
  const memory=process.memoryUsage(),cpu=process.cpuUsage(),worker=jobWorkerStatus(),engine=engineLoopStatus();
  const cloud=Boolean(process.env.K_SERVICE); const service=process.env.K_SERVICE??'локальный процесс';
  const runtimeHours=process.uptime()/3600,isTaskWorker=service.includes('worker');
  const allocatedCpu=isTaskWorker?2:1,allocatedMemoryGiB=isTaskWorker?2:0.5;
  const runtime=cloud?`Cloud Run · ${service} · ревизия ${process.env.K_REVISION??'неизвестна'} · видимый экземпляр: 1`
    :'Cloud Run не активен · локальных процессов сервиса: 1';
  const allocation=cloud?`Текущий экземпляр: ${runtimeHours.toFixed(2)} instance-ч · `+
    `${(runtimeHours*allocatedCpu).toFixed(2)} vCPU-ч · ${(runtimeHours*allocatedMemoryGiB).toFixed(2)} GiB-ч`:
    'Cloud usage: 0 (локальный владелец исполнения)';
  const scaling=cloud?'web 0–2 × 20; task workers 0–3 × 1; cycle 0–1':'профиль при cutover: web 0–2 × 20; task workers 0–3 × 1; cycle 0–1';
  const queue=process.env.CLOUD_TASKS_QUEUE
    ?`${process.env.CLOUD_TASKS_LOCATION??'?'}/${process.env.CLOUD_TASKS_QUEUE}`:'не настроены (работа в процессе)';
  const lane=(label:string,laneStatus:{iterations:number;lastIterationAt:string|null;lastStageFailures:string[]})=>
    `${label} ${laneStatus.iterations}`+
    `${laneStatus.lastIterationAt?` (последняя ${scheduleClock(laneStatus.lastIterationAt,config.timezone)})`:''}`+
    `${laneStatus.lastStageFailures.length?` · сбои: ${laneStatus.lastStageFailures.join(', ')}`:''}`;
  const cycle=engine.running
    ?`две полосы · ${lane('разведка:',engine.discovery)} · ${lane('оценка:',engine.judgment)}`
    :'планировщик вне этого процесса';
  return `${runtime}\n${allocation}\nПамять RSS: ${Math.round(memory.rss/1_048_576)} MiB · heap: ${Math.round(memory.heapUsed/1_048_576)} MiB\n`+
    `CPU процесса: ${((cpu.user+cpu.system)/1e6).toFixed(1)} c · uptime: ${runtimeHours.toFixed(1)} ч\n`+
    `Локальный job worker: ${worker.active}/1 · очередь: ${worker.pending}/${worker.capacity}\n`+
    `AI workers: ${config.scoreAgentConcurrencyMin}–${config.scoreAgentConcurrencyMax} · масштаб: ${scaling}\n`+
    `Telegram: ${config.telegramMode} · Cloud Tasks: ${queue}\n`+
    `Цикл: ${cycle}`;
}
export const digestPageSize = 10;
/** One vacancy's bold unique-prefix apply id: the shortest reply that still resolves it across the whole set. */
function digestApplyId(applyId: string, allApplyIds: readonly string[]): string {
  let prefixLength = 1;
  while (prefixLength < applyId.length && allApplyIds.some((other) =>
    other !== applyId && other.startsWith(applyId.slice(0, prefixLength)))) prefixLength++;
  return `<b>${escapeHtml(applyId.slice(0, prefixLength))}</b>${escapeHtml(applyId.slice(prefixLength))}`;
}
/**
 * One digest page as a plain formatted message: ten linked vacancies, score first, the reply prefix bold. The
 * prefix is computed against every apply id in the digest, not the page, because the user replies from anywhere.
 */
export function digestPageMessage(vacancies: readonly ScoredVacancy[], allApplyIds: readonly string[],
  page: number, pageCount: number): { text: string; keyboard?: InlineKeyboard } {
  const pages = pageCount > 1 ? ` · стр. ${page + 1}/${pageCount}` : '';
  const lines = [`<b>Ежедневная подборка вакансий${pages}</b>`, ''];
  for (const vacancy of vacancies.slice(0, digestPageSize)) {
    lines.push(`${digestApplyId(vacancy.applyId, allApplyIds)} · <b>${vacancy.score}</b> · `
      + `<a href="${escapeHtml(vacancy.url)}">${escapeHtml(clip(vacancy.name, 60))}</a>`);
  }
  lines.push('', 'Пришлите выделенный префикс или полный ID, чтобы получить адаптированное резюме и сопроводительное письмо.');
  if (pageCount <= 1) return { text: lines.join('\n') };
  const keyboard = new InlineKeyboard()
    .text('‹', page > 0 ? `digest:page:${page - 1}` : 'digest:noop')
    .text(`${page + 1}/${pageCount}`, 'digest:noop')
    .text('›', page < pageCount - 1 ? `digest:page:${page + 1}` : 'digest:noop');
  return { text: lines.join('\n'), keyboard };
}

export function salary(vacancy: ScoredVacancy): string {
  if (vacancy.salaryFrom == null && vacancy.salaryTo == null) return 'не указана';
  const range = vacancy.salaryFrom != null && vacancy.salaryTo != null
    ? `${vacancy.salaryFrom.toLocaleString('ru-RU')}–${vacancy.salaryTo.toLocaleString('ru-RU')}`
    : vacancy.salaryFrom != null ? `от ${vacancy.salaryFrom.toLocaleString('ru-RU')}` : `до ${vacancy.salaryTo?.toLocaleString('ru-RU')}`;
  return `${range} ${vacancy.salaryCurrency ?? ''}${vacancy.salaryGross === false ? ' на руки' : ''}`.trim();
}

const searchProfileTermsShown = 4;
const searchProfileTracksShown = 6;
const searchProfileTermLength = 60;
export interface SearchProfilePlatformView { label: string; terms: string[] }
export interface SearchProfileView { filename: string; tracks: string[]; platforms: SearchProfilePlatformView[] }

function clip(value: string, limit: number): string {
  const text = value.trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
/**
 * Every platform profile keeps its searches in a `searches` array, but names the searchable term differently:
 * a free-text query, an hh.ru search text, or a picked specialization with a facet.
 */
export function profileSearchTerms(profile: unknown): string[] {
  const searches = (profile as { searches?: unknown } | null)?.searches;
  if (!Array.isArray(searches)) return [];
  return searches.map((entry) => {
    const search = entry as Record<string, unknown>;
    const term = [search.query, search.text, search.specialization, search.name]
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
    if (!term) return '';
    const facet = typeof search.facet === 'string' && search.facet !== 'all' ? ` · ${search.facet}` : '';
    return clip(`${term.trim()}${facet}`, searchProfileTermLength);
  }).filter(Boolean);
}
export function searchProfileMessage(view: SearchProfileView): string {
  const ready = view.platforms.filter((platform) => platform.terms.length);
  const searches = ready.reduce((total, platform) => total + platform.terms.length, 0);
  const lines = ['<b>Поисковый профиль</b>', `Резюме: ${escapeHtml(clip(view.filename, searchProfileTermLength))}`];
  if (view.tracks.length) {
    const shown = view.tracks.slice(0, searchProfileTracksShown);
    lines.push(`Направления: ${shown.map((track) => escapeHtml(clip(track, searchProfileTermLength))).join(' · ')}` +
      (view.tracks.length > shown.length ? ` и ещё ${view.tracks.length - shown.length}` : ''));
  }
  if (!ready.length) {
    lines.push('', 'Поисковые запросы пока не созданы.');
    return lines.join('\n');
  }
  lines.push('', `<b>Запросы: ${searches} на ${ready.length} площадках</b>`);
  for (const platform of ready) {
    const shown = platform.terms.slice(0, searchProfileTermsShown);
    lines.push(`• ${escapeHtml(platform.label)}: ${shown.map((term) => `«${escapeHtml(term)}»`).join(', ')}` +
      (platform.terms.length > shown.length ? ` и ещё ${platform.terms.length - shown.length}` : ''));
  }
  const empty = view.platforms.filter((platform) => !platform.terms.length);
  if (empty.length) lines.push(`Без запросов: ${empty.map((platform) => escapeHtml(platform.label)).join(', ')}.`);
  lines.push('', 'Запросы будут использованы в следующем цикле поиска. Заменить резюме: /cv.');
  return lines.join('\n');
}

export const artifactLabels = {
  cv: { button: '📄 Резюме', loader: 'Адаптирую резюме', sending: 'Отправляю резюме', noun: 'резюме' },
  letter: { button: '✉️ Письмо', loader: 'Пишу письмо', sending: 'Отправляю письмо', noun: 'сопроводительное письмо' },
} as const satisfies Record<ApplicationArtifact, { button: string; loader: string; sending: string; noun: string }>;

/**
 * The CV and the letter are separate asks: a vacancy may not be worth a fresh CV, or may not take a letter at all,
 * and each has its own daily budget. Offering one button per deliverable keeps the choice with the user.
 */
export function applicationKeyboard(vacancy: Pick<ScoredVacancy, 'id' | 'source' | 'url'>, withSkip: boolean): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (withSkip) keyboard.text('Пропустить', `skip:${vacancy.id}`);
  return keyboard.text(artifactLabels.cv.button, `cv:${vacancy.id}`)
    .text(artifactLabels.letter.button, `letter:${vacancy.id}`).row()
    .url(`Открыть ${sourceLabel(vacancy.source)}`, vacancy.url);
}


export const headerCell = (text: string, align: 'left' | 'center' | 'right'): RichBlockTableCell => ({
  text: { type: 'bold', text }, is_header: true, align, valign: 'middle',
});
export const cell = (text: RichText, align: 'left' | 'center' | 'right' = 'left'): RichBlockTableCell => ({ text, align, valign: 'middle' });
