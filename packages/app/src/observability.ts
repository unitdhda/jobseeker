import type { Locale, LlmUsageSummary, ScraperSummary } from '@jobseeker/store';
import { escapeHtml, formatDuration, formatNumber, formatStatus, splitTelegramHtml } from './telegram/format.ts';

export interface ChartPoint { readonly primary: number; readonly secondary: number }
const blocks = ' ▁▂▃▄▅▆▇█';
function bar(value: number, maximum: number): string {
  if (maximum <= 0) return blocks[0]!;
  return blocks[Math.min(8, Math.round(value / maximum * 8))]!;
}
export function fixedChart(points: readonly ChartPoint[], count = 25): { readonly primary: string; readonly secondary: string } {
  if (count !== 25) throw new RangeError('Operational charts require exactly 25 points.');
  const normalized = points.slice(-count);
  while (normalized.length < count) normalized.unshift({ primary: 0, secondary: 0 });
  const primaryMax = Math.max(0, ...normalized.map((point) => point.primary));
  const secondaryMax = Math.max(0, ...normalized.map((point) => point.secondary));
  return Object.freeze({ primary: normalized.map((point) => bar(point.primary, primaryMax)).join(''),
    secondary: normalized.map((point) => bar(point.secondary, secondaryMax)).join('') });
}

const timelineHours = 24, timelineWidth = timelineHours * 2 + 1, timelineHeight = 12;
function niceStep(maximum: number): number {
  if (maximum <= 0) return 0; const raw = maximum / timelineHeight, power = 10 ** Math.floor(Math.log10(raw)), scaled = raw / power;
  return (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10) * power;
}
function localHour(value: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' }).format(value);
}
function putLabel(target: string[], center: number, label: string): void {
  const start = Math.max(0, Math.min(target.length - label.length, center - Math.floor(label.length / 2)));
  for (let index = 0; index < label.length; index++) target[start + index] = label[index]!;
}
function drawSeries(values: readonly number[], maximum: number, marker: '●' | '○'): string[][] {
  const grid = Array.from({ length: timelineHeight }, () => Array<string>(timelineWidth).fill(' '));
  const rows = values.map((value) => maximum <= 0 ? timelineHeight - 1
    : Math.round((1 - Math.max(0, Math.min(value / maximum, 1))) * (timelineHeight - 1)));
  const put = (row: number, column: number, symbol: string, force = false) => {
    const current = grid[row]![column]!;
    if (force || current === ' ' || ('╭╮╯╰'.includes(symbol) && !'●○'.includes(current))) grid[row]![column] = symbol;
  };
  for (let hour = 0; hour < timelineHours; hour++) {
    const column = hour * 2, nextColumn = column + 2, row = rows[hour]!, next = rows[hour + 1]!;
    if (row === next) { put(row, column, '─'); put(row, column + 1, '─'); put(row, nextColumn, '─'); continue; }
    if (next < row) { put(row, column, '─'); put(row, column + 1, '╯');
      for (let vertical = next + 1; vertical < row; vertical++) put(vertical, column + 1, '│');
      put(next, column + 1, '╭'); put(next, nextColumn, '─'); continue; }
    put(row, column, '─'); put(row, column + 1, '─'); put(row, nextColumn, '╮');
    for (let vertical = row + 1; vertical < next; vertical++) put(vertical, nextColumn, '│'); put(next, nextColumn, '╰');
  }
  for (let hour = 0; hour <= timelineHours; hour++) put(rows[hour]!, hour * 2, marker, true);
  return grid;
}
const heavy: Readonly<Record<string, string>> = { '─': '━', '│': '┃', '╭': '┏', '╮': '┓', '╯': '┛', '╰': '┗' };
function mergeSeries(left: string[][], right: string[][]): string[][] {
  const rank = (cell: string) => '●○'.includes(cell) ? 3 : '╭╮╯╰'.includes(cell) ? 2 : cell === '│' ? 1 : 0;
  return left.map((row, rowIndex) => row.map((cell, column) => { const other = right[rowIndex]![column]!;
    if (other === ' ') return cell; if (cell === ' ') return other; if (cell === '●' && other === '○') return '◐';
    const shape = rank(cell) > rank(other) ? cell : other; return heavy[shape] ?? shape; }));
}
function timelineChart(points: readonly { at: Date; left: number; right: number }[], timezone: string, locale: Locale,
  legend: string, rightLabel: (value: number, maximum: number) => string): string {
  if (points.length !== 25) throw new Error('Timeline must contain 25 hourly points.');
  const leftStep = niceStep(Math.max(0, ...points.map((point) => point.left)));
  const rightStep = niceStep(Math.max(0, ...points.map((point) => point.right)));
  const leftMaximum = leftStep * timelineHeight, rightMaximum = rightStep * timelineHeight;
  const grid = mergeSeries(drawSeries(points.map((point) => point.left), leftMaximum, '●'),
    drawSeries(points.map((point) => point.right), rightMaximum, '○'));
  const labels = Array.from({ length: timelineHeight }, (_, row) => formatNumber(leftStep * (timelineHeight - row), locale));
  const width = Math.max(1, ...labels.map((label) => label.length));
  const lines = [legend, locale === 'ru' ? '2 символа на час · точка каждый час · ━ и ◐ — серии совпадают'
    : '2 characters per hour · one point each hour · ━ and ◐ mean both series coincide', `${' '.repeat(width + 1)}┌${'─'.repeat(timelineWidth)}┐`];
  for (let row = 0; row < timelineHeight; row++) lines.push(`${labels[row]!.padStart(width)} │${grid[row]!.join('')}│ ${rightLabel(rightStep * (timelineHeight - row), rightMaximum)}`);
  lines.push(`${'0'.padStart(width)} └${'─'.repeat(timelineWidth)}┘ ${rightLabel(0, rightMaximum)}`);
  const times = Array<string>(timelineWidth).fill(' '); for (let hour = 0; hour <= timelineHours; hour += 4) putLabel(times, hour * 2, localHour(points[hour]!.at, timezone));
  lines.push(`${' '.repeat(width + 1)}${times.join('')}`);
  const days = Array<string>(timelineWidth).fill(' '); putLabel(days, 2, locale === 'ru' ? 'вчера' : 'yesterday'); putLabel(days, timelineWidth - 4, locale === 'ru' ? 'сегодня' : 'today');
  lines.push(`${' '.repeat(width + 1)}${days.join('')}`); return lines.join('\n');
}
function compact(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}
function money(value: number): string { return `$${value < 0.01 ? value.toFixed(6) : value.toFixed(2)}`; }

export function usageStatus(summary: LlmUsageSummary, locale: Locale, timezone = 'UTC'): readonly string[] {
  const chart = timelineChart(summary.hours.map((hour) => ({ at: hour.at, left: hour.tokens, right: hour.costUsd })), timezone, locale,
    locale === 'ru' ? '● Токены — левая ось             ○ Деньги — правая ось' : '● Tokens — left axis             ○ Money — right axis',
    (value, maximum) => `$${value.toFixed(maximum >= 0.01 ? 3 : maximum >= 0.001 ? 4 : 6)}`);
  return splitTelegramHtml([
    `<b>${locale === 'ru' ? 'Использование — 24 часа / всё время' : 'Usage — 24 hours / all time'}</b>`,
    `${locale === 'ru' ? 'LLM-вызовы' : 'LLM calls'}: <b>${formatNumber(summary.turns24h, locale)} / ${formatNumber(summary.turnsTotal, locale)}</b>`,
    `${locale === 'ru' ? 'Токены' : 'Tokens'}: <b>${compact(summary.tokens24h, locale)} / ${compact(summary.tokensTotal, locale)}</b>`,
    `${locale === 'ru' ? 'Вход' : 'Input'}: ${compact(summary.inputTokens24h, locale)} / ${compact(summary.inputTokensTotal, locale)} · ${locale === 'ru' ? 'выход' : 'output'}: ${compact(summary.outputTokens24h, locale)} / ${compact(summary.outputTokensTotal, locale)}`,
    `${locale === 'ru' ? 'Чтение кэша' : 'Cache read'}: ${compact(summary.cacheReadTokens24h, locale)} / ${compact(summary.cacheReadTokensTotal, locale)} · ${locale === 'ru' ? 'запись' : 'write'}: ${compact(summary.cacheWriteTokens24h, locale)} / ${compact(summary.cacheWriteTokensTotal, locale)}`,
    `${locale === 'ru' ? 'Стоимость модели' : 'Model cost'}: <b>${money(summary.cost24h)} / ${money(summary.costTotal)}</b>`,
    '', `<b>${locale === 'ru' ? 'Почасовая динамика за 24 часа' : 'Hour by hour over 24 hours'}</b>`, `<pre>${escapeHtml(chart)}</pre>`,
  ]);
}

export function scraperStatus(summary: ScraperSummary, configuredSources: readonly string[], locale: Locale,
  timezone = 'UTC'): readonly string[] {
  const chart = timelineChart(summary.hours.map((hour) => ({ at: hour.at, left: hour.scored, right: hour.normalized })), timezone, locale,
    locale === 'ru' ? '● Оценки — левая ось          ○ Распознано — правая ось' : '● Scored — left axis          ○ Parsed — right axis',
    (value) => formatNumber(value, locale));
  const rows = new Map(summary.sources.map((row) => [row.source, row]));
  const all = configuredSources.map((source) => rows.get(source) ?? { source, discovered24h: 0, normalized24h: 0, failed: 0, queued: 0 });
  const lines = [`<b>${locale === 'ru' ? 'Скрейпер и парсер — 24 часа' : 'Scraper and parser — 24 hours'}</b>`,
    `${locale === 'ru' ? 'Листинги' : 'Listings'}: <b>${formatNumber(all.reduce((sum, row) => sum + row.discovered24h, 0), locale)}</b> ${locale === 'ru' ? 'новых' : 'new'} · ${locale === 'ru' ? 'распознано' : 'parsed'}: <b>${formatNumber(all.reduce((sum, row) => sum + row.normalized24h, 0), locale)}</b> · ${locale === 'ru' ? 'очередь' : 'queued'}: ${formatNumber(all.reduce((sum, row) => sum + row.queued, 0), locale)}`,
    `${locale === 'ru' ? 'Матчи' : 'Matches'}: <b>${formatNumber(summary.matched24h, locale)}</b> · ${locale === 'ru' ? 'оценки' : 'scored'}: <b>${formatNumber(summary.scored24h, locale)}</b>`,
    '', `<b>${locale === 'ru' ? 'По источникам' : 'By source'}</b>`];
  for (const row of all) lines.push(`• ${escapeHtml(row.source)}: +${formatNumber(row.discovered24h, locale)} · ${locale === 'ru' ? 'расп.' : 'parsed'} ${formatNumber(row.normalized24h, locale)} · ${locale === 'ru' ? 'сбои' : 'failed'} ${formatNumber(row.failed, locale)}`);
  lines.push('', `<b>${locale === 'ru' ? 'Поисковые единицы' : 'Search units'}</b>`);
  if (!summary.units.length) lines.push(locale === 'ru' ? 'Нет активных единиц' : 'No active units');
  for (const unit of summary.units) lines.push(`• ${escapeHtml(unit.platform)}: ${formatNumber(unit.units, locale)} · ${locale === 'ru' ? 'просрочено' : 'overdue'} ${formatNumber(unit.overdue, locale)} · ${locale === 'ru' ? 'интервал' : 'cadence'} ${formatNumber(unit.cadenceMin, locale)}–${formatNumber(unit.cadenceMax, locale)} min`);
  if (summary.parserErrors.length) { lines.push('', `<b>${locale === 'ru' ? 'Ошибки парсера за 24 часа' : 'Parser errors over 24 hours'}</b>`);
    for (const error of summary.parserErrors) lines.push(`• ${escapeHtml(error.error)} ×${formatNumber(error.count, locale)}`); }
  lines.push('', `<b>${locale === 'ru' ? 'Почасовая динамика за 24 часа' : 'Hour by hour over 24 hours'}</b>`, `<pre>${escapeHtml(chart)}</pre>`);
  return splitTelegramHtml(lines);
}

export interface RuntimeStatusInput {
  readonly uptimeMs: number; readonly rssBytes: number; readonly heapBytes: number; readonly cpuPercent: number;
  readonly workerPending: number; readonly aiActive: number; readonly aiQueued: number;
  readonly telegramMode: string; readonly engineRunning: boolean; readonly discoveryStatus: string; readonly judgmentStatus: string;
}
export function runtimeStatus(value: RuntimeStatusInput, locale: Locale): string {
  const mb = (bytes: number) => `${formatNumber(bytes / 1024 / 1024, locale, 1)} MiB`;
  return [
    `<b>${locale === 'ru' ? 'Состояние' : 'Status'}</b>`,
    `uptime: ${formatDuration(value.uptimeMs, locale)} · RSS ${mb(value.rssBytes)} · heap ${mb(value.heapBytes)} · CPU ${formatNumber(value.cpuPercent, locale, 1)}%`,
    `worker: ${value.workerPending} · AI: ${value.aiActive}/${value.aiQueued}`,
    `Telegram: ${escapeHtml(value.telegramMode)} · engine: ${formatStatus(value.engineRunning ? 'running' : 'idle', locale)}`,
    `discovery: ${escapeHtml(value.discoveryStatus)} · judgment: ${escapeHtml(value.judgmentStatus)}`,
  ].join('\n');
}
