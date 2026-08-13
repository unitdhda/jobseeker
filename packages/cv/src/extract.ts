import type { HTMLElement } from 'node-html-parser';

export const maximumCvBytes = 20 * 1024 * 1024;
export const maximumCvTextCharacters = 500_000;
const minimumCvTextCharacters = 100;

export type CvSourceFormat = 'pdf' | 'md' | 'txt' | 'docx';

export interface CvBlockProvenance {
  /** Half-open offsets into canonicalDocumentText(document). */
  readonly start: number;
  readonly end: number;
  readonly page?: number;
}

export type CvDocumentBlock =
  | { readonly type: 'heading'; readonly text: string; readonly level: number; readonly source?: CvBlockProvenance }
  | { readonly type: 'paragraph'; readonly text: string; readonly source?: CvBlockProvenance }
  | { readonly type: 'list-item'; readonly text: string; readonly source?: CvBlockProvenance }
  | { readonly type: 'table'; readonly rows: readonly (readonly string[])[]; readonly source?: CvBlockProvenance };

export type CvExtractionWarningCode =
  | 'no-headings'
  | 'no-dates'
  | 'duplicate-content'
  | 'possible-column-order';

export interface CvExtractionWarning {
  readonly code: CvExtractionWarningCode;
  readonly detail: string;
}

export interface CanonicalCvDocument {
  readonly version: 1;
  readonly blocks: readonly CvDocumentBlock[];
  readonly warnings?: readonly CvExtractionWarning[];
}

export interface ExtractedCvDocument {
  readonly text: string;
  readonly document: CanonicalCvDocument;
  readonly sourceFormat: CvSourceFormat;
  readonly mediaType: string;
  readonly parserName: string;
  readonly parserVersion: string;
}

export type CvExtractionErrorCode =
  | 'CV_TOO_LARGE'
  | 'CV_UNSUPPORTED_FORMAT'
  | 'CV_FORMAT_MISMATCH'
  | 'CV_INVALID_ENCODING'
  | 'CV_INVALID_DOCX'
  | 'CV_UNSAFE_DOCX'
  | 'CV_TEXT_TOO_SHORT'
  | 'CV_TEXT_TOO_LONG'
  | 'CV_OCR_REQUIRED'
  | 'CV_PARSE_FAILED';

export class CvExtractionError extends Error {
  readonly code: CvExtractionErrorCode;

  constructor(code: CvExtractionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CvExtractionError';
    this.code = code;
  }
}

const extensionFormats: Readonly<Record<string, CvSourceFormat>> = {
  pdf: 'pdf', docx: 'docx', md: 'md', markdown: 'md', txt: 'txt',
};
const mediaFormats: Readonly<Record<string, CvSourceFormat>> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/markdown': 'md',
  'text/x-markdown': 'md',
  'text/plain': 'txt',
};
const genericMediaTypes = new Set(['application/octet-stream', 'binary/octet-stream', '']);

function beginsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function magicFormat(bytes: Uint8Array): CvSourceFormat | null {
  if (beginsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return 'pdf';
  if (beginsWith(bytes, [0x50, 0x4b, 0x03, 0x04])
    || beginsWith(bytes, [0x50, 0x4b, 0x05, 0x06])
    || beginsWith(bytes, [0x50, 0x4b, 0x07, 0x08])) return 'docx';
  return null;
}

/** Resolves extension, explicit media type, and binary signature without trusting any signal in isolation. */
export function detectCvSourceFormat(
  filename: string,
  mediaType: string | undefined,
  bytes: Uint8Array,
): CvSourceFormat {
  const extension = /\.([^.\/\\]+)$/u.exec(filename)?.[1]?.toLowerCase();
  const format = extension ? extensionFormats[extension] : undefined;
  if (!format) {
    throw new CvExtractionError('CV_UNSUPPORTED_FORMAT', 'Unsupported CV filename extension.');
  }

  const normalizedMedia = (mediaType ?? '').split(';', 1)[0]!.trim().toLowerCase();
  const mediaFormat = mediaFormats[normalizedMedia];
  if (!mediaFormat && !genericMediaTypes.has(normalizedMedia)) {
    throw new CvExtractionError('CV_UNSUPPORTED_FORMAT', 'Unsupported CV media type.');
  }
  if (mediaFormat && mediaFormat !== format) {
    throw new CvExtractionError('CV_FORMAT_MISMATCH', 'CV filename extension and media type disagree.');
  }

  const magic = magicFormat(bytes);
  if ((format === 'pdf' || format === 'docx') && magic !== format) {
    throw new CvExtractionError('CV_FORMAT_MISMATCH', 'CV filename extension and binary signature disagree.');
  }
  if ((format === 'md' || format === 'txt') && magic !== null) {
    throw new CvExtractionError('CV_FORMAT_MISMATCH', 'Text CV has a binary PDF or ZIP signature.');
  }
  return format;
}

const windows1251Extended = [
  'Ђ', 'Ѓ', '‚', 'ѓ', '„', '…', '†', '‡', '€', '‰', 'Љ', '‹', 'Њ', 'Ќ', 'Ћ', 'Џ',
  'ђ', '‘', '’', '“', '”', '•', '–', '—', null, '™', 'љ', '›', 'њ', 'ќ', 'ћ', 'џ',
  '\u00a0', 'Ў', 'ў', 'Ј', '¤', 'Ґ', '¦', '§', 'Ё', '©', 'Є', '«', '¬', '\u00ad', '®', 'Ї',
  '°', '±', 'І', 'і', 'ґ', 'µ', '¶', '·', 'ё', '№', 'є', '»', 'ј', 'Ѕ', 'ѕ', 'ї',
] as const;

/** Bun does not expose every legacy TextDecoder label, so the small fallback table is kept runtime-independent. */
function decodeWindows1251(bytes: Uint8Array): string {
  let result = '';
  for (const byte of bytes) {
    if (byte < 0x80) result += String.fromCharCode(byte);
    else if (byte < 0xc0) {
      const character = windows1251Extended[byte - 0x80];
      if (character === null) throw new TypeError('Windows-1251 input contains undefined byte 0x98.');
      result += character;
    } else result += String.fromCharCode(0x0410 + byte - 0xc0);
  }
  return result;
}

function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return decodeWindows1251(bytes);
    } catch (error) {
      throw new CvExtractionError('CV_INVALID_ENCODING', 'CV text is neither valid UTF-8 nor Windows-1251.', { cause: error });
    }
  }
}

function normalizeText(value: string): string {
  return value.normalize('NFC')
    .replace(/\u0000/gu, '')
    .replace(/\u00a0/gu, ' ')
    .replace(/\r\n?/gu, '\n')
    .replace(/\t/gu, ' ')
    .split('\n').map((line) => line.replace(/[ \f\v]+$/gu, '')).join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function blockValue(block: CvDocumentBlock): string {
  return block.type === 'table'
    ? block.rows.map((row) => row.join(' | ')).join('\n')
    : block.text;
}

export function canonicalDocumentText(document: CanonicalCvDocument): string {
  return document.blocks.map(blockValue).join('\n\n');
}

function annotateBlocks(blocks: readonly CvDocumentBlock[]): CvDocumentBlock[] {
  let offset = 0;
  return blocks.map((block) => {
    const value = blockValue(block);
    const source = { start: offset, end: offset + value.length, ...(block.source?.page ? { page: block.source.page } : {}) };
    offset = source.end + 2;
    return { ...block, source } as CvDocumentBlock;
  });
}

function warningsFor(blocks: readonly CvDocumentBlock[], possibleColumns = false): CvExtractionWarning[] {
  const warnings: CvExtractionWarning[] = [];
  const text = blocks.map(blockValue).join('\n');
  if (!blocks.some((block) => block.type === 'heading')) {
    warnings.push({ code: 'no-headings', detail: 'No recoverable heading structure was detected.' });
  }
  if (!/\b(?:19|20)\d{2}\b/u.test(text)) {
    warnings.push({ code: 'no-dates', detail: 'No four-digit year was detected.' });
  }
  const seen = new Set<string>();
  if (blocks.some((block) => {
    const value = normalizeText(blockValue(block)).toLowerCase();
    if (value.length < 80) return false;
    if (seen.has(value)) return true;
    seen.add(value);
    return false;
  })) warnings.push({ code: 'duplicate-content', detail: 'Repeated long content was detected.' });
  if (possibleColumns) warnings.push({
    code: 'possible-column-order',
    detail: 'PDF coordinates suggest interleaved columns; verify reading order.',
  });
  return warnings;
}

function finishDocument(blocks: readonly CvDocumentBlock[], possibleColumns = false): CanonicalCvDocument {
  const cleaned = blocks.flatMap((block): CvDocumentBlock[] => {
    if (block.type === 'table') {
      const rows = block.rows.map((row) => row.map(normalizeText).filter(Boolean)).filter((row) => row.length > 0);
      return rows.length ? [{ ...block, rows }] : [];
    }
    const text = normalizeText(block.text);
    return text ? [{ ...block, text }] : [];
  });
  const annotated = annotateBlocks(cleaned);
  const warnings = warningsFor(annotated, possibleColumns);
  return Object.freeze({
    version: 1,
    blocks: Object.freeze(annotated),
    ...(warnings.length
      ? { warnings: Object.freeze(warnings.map((warning) => Object.freeze({ ...warning }))) }
      : {}),
  });
}

function assertNormalizedText(text: string, ocr = false): void {
  const nonWhitespace = text.replace(/\s/gu, '').length;
  if (nonWhitespace < minimumCvTextCharacters) {
    throw new CvExtractionError(
      ocr ? 'CV_OCR_REQUIRED' : 'CV_TEXT_TOO_SHORT',
      ocr ? 'PDF contains too little extractable text and requires OCR.' : 'CV contains fewer than 100 non-whitespace characters.',
    );
  }
  if (text.length > maximumCvTextCharacters) {
    throw new CvExtractionError('CV_TEXT_TOO_LONG', 'Normalized CV text exceeds 500,000 characters.');
  }
}

function stripMarkdownInline(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/\*\*([^*]+)\*\*/gu, '$1')
    .replace(/__([^_]+)__/gu, '$1')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/gu, '$1')
    .replace(/(?<!_)_([^_]+)_(?!_)/gu, '$1')
    .replace(/\\([\\`*_[\]{}()#+.!-])/gu, '$1')
    .trim();
}

function markdownBlocks(source: string): CvDocumentBlock[] {
  const lines = source.split('\n');
  const blocks: CvDocumentBlock[] = [];
  let paragraph: string[] = [];
  let fenced = false;
  const flush = (): void => {
    if (paragraph.length) blocks.push({ type: 'paragraph', text: stripMarkdownInline(paragraph.join(' ')) });
    paragraph = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^\s*```/u.test(line)) { flush(); fenced = !fenced; continue; }
    if (fenced) { paragraph.push(line); continue; }
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (heading) { flush(); blocks.push({ type: 'heading', level: heading[1]!.length, text: stripMarkdownInline(heading[2]!) }); continue; }
    const list = /^\s*(?:[-*+] |\d+[.)]\s+)(.+)$/u.exec(line);
    if (list) { flush(); blocks.push({ type: 'list-item', text: stripMarkdownInline(list[1]!) }); continue; }
    if (/^\s*>/u.test(line)) { paragraph.push(line.replace(/^\s*>\s?/u, '')); continue; }
    if (line.includes('|') && index + 1 < lines.length && /^\s*\|?\s*:?-+/u.test(lines[index + 1]!)) {
      flush();
      const rows: string[][] = [];
      const row = (value: string): string[] => value.replace(/^\s*\||\|\s*$/gu, '').split('|').map(stripMarkdownInline);
      rows.push(row(line));
      index += 2;
      while (index < lines.length && lines[index]!.includes('|') && lines[index]!.trim()) {
        rows.push(row(lines[index]!));
        index += 1;
      }
      index -= 1;
      blocks.push({ type: 'table', rows });
      continue;
    }
    if (!line.trim()) flush();
    else paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

function textBlocks(source: string): CvDocumentBlock[] {
  const blocks: CvDocumentBlock[] = [];
  for (const paragraph of source.split(/\n\s*\n/gu)) {
    const lines = paragraph.split('\n').map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      const bullet = /^(?:[-*•‣▪◦]|\d+[.)])\s+(.+)$/u.exec(line);
      if (bullet) { blocks.push({ type: 'list-item', text: bullet[1]! }); continue; }
      const words = line.match(/\p{L}+/gu) ?? [];
      const uppercaseHeading = line.length <= 80 && words.length > 0 && words.length <= 8
        && line === line.toUpperCase() && line !== line.toLowerCase()
        && words.some((word) => word.length > 3);
      blocks.push(uppercaseHeading
        ? { type: 'heading', text: line, level: 2 }
        : { type: 'paragraph', text: line });
    }
  }
  return blocks;
}

function findEocd(bytes: Uint8Array): number {
  const minimum = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes[offset] === 0x50 && bytes[offset + 1] === 0x4b && bytes[offset + 2] === 0x05 && bytes[offset + 3] === 0x06) return offset;
  }
  return -1;
}

/** Reads only classic ZIP metadata, rejecting ambiguous ZIP64 or truncated archives before Mammoth sees bytes. */
function inspectDocxZip(bytes: Uint8Array): void {
  const eocd = findEocd(bytes);
  if (eocd < 0) throw new CvExtractionError('CV_INVALID_DOCX', 'DOCX ZIP central directory is missing or truncated.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (entries === 0) throw new CvExtractionError('CV_INVALID_DOCX', 'DOCX ZIP contains no readable entries.');
  if (entries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff
    || (eocd >= 20 && view.getUint32(eocd - 20, true) === 0x07064b50)) {
    throw new CvExtractionError('CV_UNSAFE_DOCX', 'ZIP64 DOCX archives are not supported.');
  }
  if (entries > 2_000) throw new CvExtractionError('CV_UNSAFE_DOCX', 'DOCX ZIP contains more than 2,000 entries.');
  if (directoryOffset + directorySize > eocd) {
    throw new CvExtractionError('CV_INVALID_DOCX', 'DOCX ZIP central directory is truncated.');
  }

  let offset = directoryOffset;
  let compressedTotal = 0;
  let uncompressedTotal = 0;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > eocd || view.getUint32(offset, true) !== 0x02014b50) {
      throw new CvExtractionError('CV_INVALID_DOCX', 'DOCX ZIP central directory entry is truncated.');
    }
    const compressed = view.getUint32(offset + 20, true);
    const uncompressed = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    if (compressed === 0xffffffff || uncompressed === 0xffffffff) {
      throw new CvExtractionError('CV_UNSAFE_DOCX', 'ZIP64 DOCX entries are not supported.');
    }
    compressedTotal += compressed;
    uncompressedTotal += uncompressed;
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset > eocd) throw new CvExtractionError('CV_INVALID_DOCX', 'DOCX ZIP central directory is truncated.');
  if (uncompressedTotal > 50 * 1024 * 1024) {
    throw new CvExtractionError('CV_UNSAFE_DOCX', 'DOCX ZIP exceeds 50 MiB uncompressed.');
  }
  if (uncompressedTotal > 0 && (compressedTotal === 0 || uncompressedTotal / compressedTotal > 100)) {
    throw new CvExtractionError('CV_UNSAFE_DOCX', 'DOCX ZIP compression ratio exceeds 100.');
  }
}

function htmlBlocks(root: HTMLElement): CvDocumentBlock[] {
  const blocks: CvDocumentBlock[] = [];
  const visit = (node: HTMLElement): void => {
    const tag = node.tagName?.toLowerCase();
    if (tag && /^h[1-6]$/u.test(tag)) {
      blocks.push({ type: 'heading', text: node.textContent, level: Number(tag[1]) });
      return;
    }
    if (tag === 'li') { blocks.push({ type: 'list-item', text: node.textContent }); return; }
    if (tag === 'p') { blocks.push({ type: 'paragraph', text: node.textContent }); return; }
    if (tag === 'table') {
      const rows = node.querySelectorAll('tr').map((row) => row.querySelectorAll('th,td').map((cell) => cell.textContent));
      if (rows.length) blocks.push({ type: 'table', rows });
      return;
    }
    for (const child of node.childNodes) {
      if ('tagName' in child) visit(child as HTMLElement);
    }
  };
  visit(root);
  return blocks;
}

async function extractDocx(bytes: Uint8Array): Promise<{ blocks: CvDocumentBlock[]; rawText: string }> {
  inspectDocxZip(bytes);
  const mammoth = (await import('mammoth')).default;
  const input = { buffer: Buffer.from(bytes) };
  const [raw, html] = await Promise.all([
    mammoth.extractRawText(input),
    mammoth.convertToHtml(input, { externalFileAccess: false }),
  ]);
  const { parse } = await import('node-html-parser');
  const semantic = htmlBlocks(parse(html.value));
  return { blocks: semantic.length ? semantic : textBlocks(raw.value), rawText: raw.value };
}

async function extractPdf(bytes: Uint8Array): Promise<{ blocks: CvDocumentBlock[]; possibleColumns: boolean }> {
  const { extractTextItems } = await import('unpdf');
  const result = await extractTextItems(new Uint8Array(bytes));
  const blocks: CvDocumentBlock[] = [];
  let possibleColumns = false;
  result.items.forEach((items, pageIndex) => {
    const lines: string[] = [];
    let line = '';
    let previousX: number | null = null;
    let resets = 0;
    for (const item of items) {
      if (previousX !== null && item.x + 100 < previousX && !item.hasEOL) resets += 1;
      line += `${line && !/^\s/u.test(item.str) ? ' ' : ''}${item.str}`;
      previousX = item.x + item.width;
      if (item.hasEOL) { if (line.trim()) lines.push(line); line = ''; previousX = null; }
    }
    if (line.trim()) lines.push(line);
    if (resets >= 3) possibleColumns = true;
    for (const value of lines) blocks.push({ type: 'paragraph', text: value, source: { start: 0, end: 0, page: pageIndex + 1 } });
  });
  return { blocks, possibleColumns };
}

export async function extractCvDocument(
  filename: string,
  mediaType: string | undefined,
  bytes: Uint8Array,
): Promise<ExtractedCvDocument> {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Invalid CV bytes: expected Uint8Array.');
  if (bytes.byteLength > maximumCvBytes) {
    throw new CvExtractionError('CV_TOO_LARGE', 'CV upload exceeds 20 MiB.');
  }
  const format = detectCvSourceFormat(filename, mediaType, bytes);

  try {
    let document: CanonicalCvDocument;
    let parserName: string;
    let parserVersion: string;
    if (format === 'pdf') {
      const pdf = await extractPdf(bytes);
      document = finishDocument(pdf.blocks, pdf.possibleColumns);
      parserName = 'unpdf'; parserVersion = '1.8.0';
    } else if (format === 'docx') {
      const docx = await extractDocx(bytes);
      document = finishDocument(docx.blocks);
      parserName = 'mammoth'; parserVersion = '1.12.0';
    } else {
      const decoded = normalizeText(decodeText(bytes));
      document = finishDocument(format === 'md' ? markdownBlocks(decoded) : textBlocks(decoded));
      parserName = format === 'md' ? 'jobseeker-markdown' : 'jobseeker-text'; parserVersion = '1';
    }
    const text = canonicalDocumentText(document);
    assertNormalizedText(text, format === 'pdf');
    return Object.freeze({
      text,
      document,
      sourceFormat: format,
      mediaType: mediaType?.split(';', 1)[0]?.trim().toLowerCase() || 'application/octet-stream',
      parserName,
      parserVersion,
    });
  } catch (error) {
    if (error instanceof CvExtractionError) throw error;
    throw new CvExtractionError('CV_PARSE_FAILED', 'CV parser failed to produce a canonical document.', { cause: error });
  }
}

export type CvLanguage = 'ru' | 'en';

export function detectCvLanguage(text: string): CvLanguage {
  const cyrillic = text.match(/\p{Script=Cyrillic}/gu)?.length ?? 0;
  const latin = text.match(/\p{Script=Latin}/gu)?.length ?? 0;
  return cyrillic >= 20 && cyrillic / Math.max(1, cyrillic + latin) >= 0.3 ? 'ru' : 'en';
}
