import { InlineKeyboard } from 'grammy';
import { type RichBlockTableCell, type RichText } from 'grammy/types';
import { config } from '../config.ts';
import { type ScoredVacancy, type TelegramUser, type UsageHour } from '../database.ts';
import { getSearchPlatform } from '../vacancies/registry.ts';
import { jobWorkerStatus } from '../worker-client.ts';
import { type ApplicationArtifact } from '../database.ts';
import { cycleScheduleStatus } from '../vacancies/jobs.ts';


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
  const memory=process.memoryUsage(),cpu=process.cpuUsage(),worker=jobWorkerStatus(),schedule=cycleScheduleStatus();
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
  const cycle=schedule.scheduled
    ?`в этом процессе · ${schedule.cron} · ${schedule.timezone}`+
      `${schedule.nextRunAt?` · следующий в ${scheduleClock(schedule.nextRunAt,schedule.timezone)}`:''}`
    :`внешний планировщик · профиль ${schedule.cron} · ${schedule.timezone}`;
  return `${runtime}\n${allocation}\nПамять RSS: ${Math.round(memory.rss/1_048_576)} MiB · heap: ${Math.round(memory.heapUsed/1_048_576)} MiB\n`+
    `CPU процесса: ${((cpu.user+cpu.system)/1e6).toFixed(1)} c · uptime: ${runtimeHours.toFixed(1)} ч\n`+
    `Локальный job worker: ${worker.active}/1 · очередь: ${worker.pending}/${worker.capacity}\n`+
    `AI workers: ${config.scoreAgentConcurrencyMin}–${config.scoreAgentConcurrencyMax} · масштаб: ${scaling}\n`+
    `Telegram: ${config.telegramMode} · Cloud Tasks: ${queue}\n`+
    `Цикл: ${cycle}`;
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
