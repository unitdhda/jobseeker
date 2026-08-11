import { InlineKeyboard } from 'grammy';
import { type RichBlockTableCell, type RichText } from 'grammy/types';
import { config } from '../config.ts';
import { type ScoredVacancy, type ScraperHour, type ScraperSummary, type TelegramUser, type UsageHour } from '../postgres.ts';
import { getSearchPlatform } from '../vacancies/registry.ts';
import { jobWorkerStatus } from '../worker-client.ts';
import { type ApplicationArtifact } from '../postgres.ts';
import { engineLoopStatus } from '@jobseeker/engine';
import { messages, type Locale } from '../i18n/index.ts';


// The double quote matters as much as the brackets: escaped output is also placed inside href="…" attributes.
export function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
// A source names itself: the label is whatever the registered provider calls itself, so the application carries no
// list of sources it might one day meet. Only the fallback for an id no longer registered is translated.
export function sourceLabel(source: string, locale: Locale): string {
  try { return getSearchPlatform(source).name; } catch { return messages(locale).common.unknownSource; }
}
// Search profiles are shown per platform, and a platform is always registered when its profile is on screen.
export function platformLabel(platformId: string): string {
  return getSearchPlatform(platformId).name;
}
export function userStatusText(status: TelegramUser['status'], locale: Locale): string {
  return messages(locale).userStatus[status];
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
function axisInteger(value:number,locale:Locale):string{
  return Math.round(value).toLocaleString(messages(locale).tag).replace(/[\u00a0\u202f]/g,' ');
}
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
  // A marker on every hour — every second cell, since an hour is two characters wide. Forced over whatever the
  // stroke left there, so a data point is never hidden behind the corner that leads into it.
  for(let hour=0;hour<=usagePlotHours;hour++)put(rows[hour]!,hour*2,marker,true);
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
  timezone:string,locale:Locale):string{
  const text=messages(locale);
  if(points.length!==usagePlotHours+1)throw new Error('Timeline must contain 25 hourly points.');
  const leftStep=niceUsageStep(Math.max(...points.map(point=>point.left),0));
  const rightStep=niceUsageStep(Math.max(...points.map(point=>point.right),0));
  const leftMaximum=leftStep*usagePlotHeight,rightMaximum=rightStep*usagePlotHeight;
  const grid=mergeUsageSeries(drawUsageSeries(points.map(point=>point.left),leftMaximum,'●'),
    drawUsageSeries(points.map(point=>point.right),rightMaximum,'○'));
  const leftLabels=Array.from({length:usagePlotHeight},(_,row)=>axisInteger(leftStep*(usagePlotHeight-row),locale));
  const leftWidth=Math.max(1,...leftLabels.map(label=>label.length));
  const lines=[legend,text.charts.scale,`${' '.repeat(leftWidth+1)}┌${'─'.repeat(usagePlotWidth)}┐`];
  for(let row=0;row<usagePlotHeight;row++)lines.push(`${leftLabels[row]!.padStart(leftWidth)} │${grid[row]!.join('')}│ `+
    rightAxis(rightStep*(usagePlotHeight-row),rightMaximum));
  lines.push(`${'0'.padStart(leftWidth)} └${'─'.repeat(usagePlotWidth)}┘ ${rightAxis(0,rightMaximum)}`);
  const timeLabels=Array<string>(usagePlotWidth).fill(' ');
  for(let hour=0;hour<=usagePlotHours;hour+=4)placeLabel(timeLabels,hour*2,localHourLabel(points[hour]!.at,timezone));
  lines.push(`${' '.repeat(leftWidth+1)}${timeLabels.join('')}`);
  const dayLabels=Array<string>(usagePlotWidth).fill(' ');placeLabel(dayLabels,2,text.charts.yesterday);
  placeLabel(dayLabels,usagePlotWidth-4,text.charts.today);
  lines.push(`${' '.repeat(leftWidth+1)}${dayLabels.join('')}`);
  const timeCaption=Array<string>(usagePlotWidth).fill(' ');
  placeLabel(timeCaption,Math.floor(usagePlotWidth/2),text.charts.localTime);
  lines.push(`${' '.repeat(leftWidth+1)}${timeCaption.join('')}`);
  return lines.join('\n');
}
export function usageTimelineChart(hours:UsageHour[],timezone:string,locale:Locale):string{
  return timelineChart(hours.map(hour=>({at:hour.at,left:hour.tokens,right:hour.costUsd})),
    messages(locale).charts.usageLegend,axisMoney,timezone,locale);
}
export function scraperTimelineChart(hours:ScraperHour[],timezone:string,locale:Locale):string{
  return timelineChart(hours.map(hour=>({at:hour.at,left:hour.scored,right:hour.normalized})),
    messages(locale).charts.scraperLegend,(value)=>axisInteger(value,locale),timezone,locale);
}
/**
 * The scraper's day at a glance for the owner: what each adapter brought in, what the parser made of it, how the
 * scheduler is pacing the units, and what is failing — a dead adapter shows as a zero row, never as absence.
 */
export function scraperStatusMessage(summary:ScraperSummary,locale:Locale):string{
  const text=messages(locale).scraper;
  const lines=[text.title,
    text.listings(summary.sources.reduce((total,row)=>total+row.discovered24h,0),
      summary.sources.reduce((total,row)=>total+row.normalized24h,0),
      summary.sources.reduce((total,row)=>total+row.queued,0)),
    text.matches(summary.matched24h,summary.scored24h),'',text.bySource];
  for(const row of summary.sources){
    lines.push(text.sourceRow(escapeHtml(row.source),row.discovered24h,row.normalized24h,row.queued,row.failed,
      row.closed24h,row.scored24h));
  }
  lines.push('',text.units);
  for(const row of summary.units){
    const novelty=row.lastNoveltyAt
      ?text.noveltyHoursAgo(Math.round((Date.now()-Date.parse(row.lastNoveltyAt))/3_600_000)):text.noNovelty;
    lines.push(text.unitRow(escapeHtml(row.platform),row.units,row.overdue,row.cadenceMin,row.cadenceMax,novelty));
  }
  if(summary.errors.length){
    lines.push('',text.errors);
    for(const row of summary.errors)lines.push(text.errorRow(escapeHtml(row.error),row.count));
  }
  return lines.join('\n');
}
/**
 * Telegram rejects messages beyond 4096 characters, and the per-source status grew past it when the deployment
 * reached twenty sources. Splitting on line boundaries keeps each chunk's inline HTML tags intact.
 */
export function chunkMessageLines(text:string,limit=3_900):string[]{
  const chunks:string[]=[];let current='';
  for(const line of text.split('\n')){
    const candidate=current?`${current}\n${line}`:line;
    if(candidate.length>limit&&current){chunks.push(current);current=line;}
    else current=candidate;
  }
  if(current)chunks.push(current);
  return chunks;
}
export function compactNumber(value:number,locale:Locale):string{
  return new Intl.NumberFormat(messages(locale).tag,{notation:'compact',maximumFractionDigits:1}).format(value);
}
export function money(value:number):string{return `$${value<0.01?value.toFixed(6):value.toFixed(2)}`;}
// The next cycle is announced in the schedule's own timezone, because a UTC instant says nothing about when the
// owner should expect the run.
function scheduleClock(timestamp:string,timezone:string,locale:Locale):string{
  try{
    return new Intl.DateTimeFormat(messages(locale).tag,{timeZone:timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'})
      .format(new Date(timestamp));
  }catch{return timestamp;}
}
// Deployment answers "where and how is this running": process resources, worker and engine-lane health. Model
// spend lives in /usage instead, so the two commands never repeat each other.
export function deploymentStatusText(locale:Locale):string{
  const text=messages(locale).deployment;
  const memory=process.memoryUsage(),cpu=process.cpuUsage(),worker=jobWorkerStatus(),engine=engineLoopStatus();
  const runtimeHours=process.uptime()/3600;
  const lane=(label:string,laneStatus:{iterations:number;lastIterationAt:string|null;lastStageFailures:string[]})=>
    text.laneIterations(label,laneStatus.iterations)+
    (laneStatus.lastIterationAt?text.laneLastRun(scheduleClock(laneStatus.lastIterationAt,config.timezone,locale)):'')+
    (laneStatus.lastStageFailures.length?text.laneFailures(laneStatus.lastStageFailures.join(', ')):'');
  const cycle=engine.running
    ?text.lanes(lane(text.discoveryLane,engine.discovery),lane(text.judgmentLane,engine.judgment))
    :text.schedulerElsewhere;
  return [text.memory(Math.round(memory.rss/1_048_576),Math.round(memory.heapUsed/1_048_576)),
    text.cpu(((cpu.user+cpu.system)/1e6).toFixed(1),runtimeHours.toFixed(1)),
    text.worker(worker.active,worker.pending,worker.capacity),
    text.aiWorkers(config.scoreAgentConcurrencyMin,config.scoreAgentConcurrencyMax),
    text.telegram(config.telegramMode),text.cycle(cycle)].join('\n');
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
  page: number, pageCount: number, locale: Locale): { text: string; keyboard?: InlineKeyboard } {
  const text = messages(locale).digest;
  const pages = pageCount > 1 ? text.pageSuffix(page + 1, pageCount) : '';
  const lines = [text.title(pages), ''];
  for (const vacancy of vacancies.slice(0, digestPageSize)) {
    lines.push(`${digestApplyId(vacancy.applyId, allApplyIds)} · <b>${vacancy.score}</b> · `
      + `<a href="${escapeHtml(vacancy.url)}">${escapeHtml(clip(vacancy.name, 60))}</a>`);
  }
  lines.push('', text.footer);
  if (pageCount <= 1) return { text: lines.join('\n') };
  const keyboard = new InlineKeyboard()
    .text('‹', page > 0 ? `digest:page:${page - 1}` : 'digest:noop')
    .text(`${page + 1}/${pageCount}`, 'digest:noop')
    .text('›', page < pageCount - 1 ? `digest:page:${page + 1}` : 'digest:noop');
  return { text: lines.join('\n'), keyboard };
}

export function salary(vacancy: ScoredVacancy, locale: Locale): string {
  const text = messages(locale);
  if (vacancy.salaryFrom == null && vacancy.salaryTo == null) return text.alert.salaryUnspecified;
  const amount = (value: number): string => value.toLocaleString(text.tag);
  const range = vacancy.salaryFrom != null && vacancy.salaryTo != null
    ? `${amount(vacancy.salaryFrom)}–${amount(vacancy.salaryTo)}`
    : vacancy.salaryFrom != null ? text.alert.salaryFrom(amount(vacancy.salaryFrom))
      : text.alert.salaryTo(amount(vacancy.salaryTo!));
  return `${range} ${vacancy.salaryCurrency ?? ''}${vacancy.salaryGross === false ? text.alert.salaryNet : ''}`.trim();
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
export function searchProfileMessage(view: SearchProfileView, locale: Locale): string {
  const text = messages(locale).profile;
  const ready = view.platforms.filter((platform) => platform.terms.length);
  const searches = ready.reduce((total, platform) => total + platform.terms.length, 0);
  const lines = [text.title, text.filename(escapeHtml(clip(view.filename, searchProfileTermLength)))];
  if (view.tracks.length) {
    const shown = view.tracks.slice(0, searchProfileTracksShown);
    lines.push(text.tracks(shown.map((track) => escapeHtml(clip(track, searchProfileTermLength))).join(' · ')) +
      (view.tracks.length > shown.length ? text.andMore(view.tracks.length - shown.length) : ''));
  }
  if (!ready.length) {
    lines.push('', text.none);
    return lines.join('\n');
  }
  lines.push('', text.queries(searches, ready.length));
  for (const platform of ready) {
    const shown = platform.terms.slice(0, searchProfileTermsShown);
    lines.push(text.platformRow(escapeHtml(platform.label),
      shown.map((term) => text.term(escapeHtml(term))).join(', ')) +
      (platform.terms.length > shown.length ? text.andMore(platform.terms.length - shown.length) : ''));
  }
  const empty = view.platforms.filter((platform) => !platform.terms.length);
  if (empty.length) lines.push(text.withoutQueries(empty.map((platform) => escapeHtml(platform.label)).join(', ')));
  lines.push('', text.footer);
  return lines.join('\n');
}

export function artifactLabels(locale: Locale): Record<ApplicationArtifact,
{ button: string; loader: string; sending: string; noun: string }> {
  return messages(locale).application.artifacts;
}

/**
 * The CV and the letter are separate asks: a vacancy may not be worth a fresh CV, or may not take a letter at all,
 * and each has its own daily budget. Offering one button per deliverable keeps the choice with the user.
 */
export function applicationKeyboard(vacancy: Pick<ScoredVacancy, 'id' | 'source' | 'url'>, withSkip: boolean,
  locale: Locale): InlineKeyboard {
  const text = messages(locale);
  const keyboard = new InlineKeyboard();
  if (withSkip) keyboard.text(text.application.skipButton, `skip:${vacancy.id}`);
  return keyboard.text(text.application.artifacts.cv.button, `cv:${vacancy.id}`)
    .text(text.application.artifacts.letter.button, `letter:${vacancy.id}`).row()
    .url(text.common.openAt(sourceLabel(vacancy.source, locale)), vacancy.url);
}


export const headerCell = (text: string, align: 'left' | 'center' | 'right'): RichBlockTableCell => ({
  text: { type: 'bold', text }, is_header: true, align, valign: 'middle',
});
export const cell = (text: RichText, align: 'left' | 'center' | 'right' = 'left'): RichBlockTableCell => ({ text, align, valign: 'middle' });
