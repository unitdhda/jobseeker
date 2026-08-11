import {
  definePDFJSModule,
  extractText as extractTextBase,
  getDocumentProxy as getDocumentProxyBase,
} from 'unpdf';

let configured: Promise<void> | undefined;
function configurePdf(): Promise<void> {
  return configured ??= definePDFJSModule(() => import('pdfjs-dist/legacy/build/pdf.mjs'));
}

export async function getDocumentProxy(...args: Parameters<typeof getDocumentProxyBase>) {
  await configurePdf();
  return getDocumentProxyBase(...args);
}

export async function extractText(...args: Parameters<typeof extractTextBase>) {
  await configurePdf();
  return extractTextBase(...args);
}

export const maximumCvBytes = 20 * 1024 * 1024;

import { extname } from 'node:path';
import mammoth from 'mammoth';
import { parse } from 'node-html-parser';

export type CvSourceFormat = 'pdf' | 'md' | 'txt' | 'docx';
export interface CvBlockProvenance { start: number; end: number; page?: number }
export type CvDocumentBlock =
  | { type: 'heading'; text: string; level: number; source?: CvBlockProvenance }
  | { type: 'paragraph'; text: string; source?: CvBlockProvenance }
  | { type: 'list-item'; text: string; source?: CvBlockProvenance }
  | { type: 'table'; rows: string[][]; source?: CvBlockProvenance };
export type CvExtractionWarningCode = 'no-headings'|'no-dates'|'duplicate-content'|'possible-column-order';
export interface CvExtractionWarning { code:CvExtractionWarningCode; detail:string }
export interface CanonicalCvDocument { version: 1; blocks: CvDocumentBlock[]; warnings?:CvExtractionWarning[] }
export interface ExtractedCvDocument {
  text: string;
  document: CanonicalCvDocument;
  sourceFormat: CvSourceFormat;
  mediaType: string;
  parserName: string;
  parserVersion: string;
}

const mediaTypes: Record<CvSourceFormat, string> = {
  pdf: 'application/pdf', md: 'text/markdown', txt: 'text/plain',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const maximumExtractedCharacters = 500_000;
const maximumDocxEntries = 2_000;
const maximumDocxUncompressedBytes = 50 * 1024 * 1024;
const maximumDocxCompressionRatio = 100;

function blockText(block:CvDocumentBlock):string {
  return block.type==='table'?block.rows.map((row)=>row.join(' | ')).join('\n'):block.text;
}
function annotateDocument(document:CanonicalCvDocument,text:string):CanonicalCvDocument {
  let cursor=0;
  const blocks=document.blocks.map((block)=>{
    const value=blockText(block).replace(/^•\s+/,'').trim();
    let start=text.indexOf(value,cursor);
    if(start<0)start=text.indexOf(value);
    if(start<0)return block;
    const end=start+value.length;cursor=end;return{...block,source:{start,end}};
  });
  const warnings:CvExtractionWarning[]=[];
  if(!blocks.some((block)=>block.type==='heading'))warnings.push({code:'no-headings',detail:'No section headings were detected.'});
  if(!/\b(?:19|20)\d{2}\b/.test(text))warnings.push({code:'no-dates',detail:'No four-digit dates were detected.'});
  const counts=new Map<string,number>();
  for(const block of blocks){const key=blockText(block).toLowerCase().replace(/\s+/g,' ').trim();if(key.length>=30)counts.set(key,(counts.get(key)??0)+1);}
  if([...counts.values()].some((count)=>count>1))warnings.push({code:'duplicate-content',detail:'Repeated extracted paragraphs were detected.'});
  const shortRuns=blocks.filter((block)=>block.type==='paragraph'&&block.text.length<24).length;
  if(blocks.length>=20&&shortRuns/blocks.length>0.6)warnings.push({code:'possible-column-order',detail:'Many short lines may indicate interleaved columns.'});
  return {version:1,blocks,warnings};
}

function normalizeText(value: string): string {
  const normalized = value.normalize('NFC').replaceAll('\u0000', '').replaceAll('\u00a0', ' ')
    .replace(/\r\n?/g, '\n').replace(/[\t\v\f]+/g, ' ')
    .split('\n').map((line) => line.replace(/[ ]+$/g, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
  if (normalized.length < 100) throw new Error('The CV contains too little extractable text.');
  if (normalized.length > maximumExtractedCharacters) throw new Error('The extracted CV text is too large.');
  return normalized;
}

function cleanInlineMarkdown(value: string): string {
  return value.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(?:\*\*|__|~~|`)(.*?)(?:\*\*|__|~~|`)/g, '$1').replace(/\\([#*_`[\]()])/g, '$1').trim();
}

function plainBlocks(text: string): CanonicalCvDocument {
  const blocks: CvDocumentBlock[] = [];
  for (const paragraph of text.split(/\n\s*\n/)) {
    const lines = paragraph.split('\n').map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      const bullet = /^[•\-–—*]\s+(.+)$/.exec(line);
      if (bullet) { blocks.push({ type: 'list-item', text: bullet[1].trim() }); continue; }
      const letters = line.match(/[\p{L}]/gu)?.length ?? 0;
      const uppercase = line.match(/[\p{Lu}]/gu)?.length ?? 0;
      if (letters >= 4 && uppercase / letters > 0.8 && line.length < 100) {
        blocks.push({ type: 'heading', text: line, level: 2 });
      } else blocks.push({ type: 'paragraph', text: line });
    }
  }
  return { version: 1, blocks };
}

function htmlDocument(source: string): CanonicalCvDocument {
  const root = parse(source);
  const blocks: CvDocumentBlock[] = [];
  for (const element of root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,table')) {
    const tag = element.rawTagName.toLowerCase();
    if (tag !== 'table' && element.closest('table')) continue;
    if (tag === 'p' && element.closest('li')) continue;
    if (tag === 'table') {
      const rows = element.querySelectorAll('tr').map((row) => row.querySelectorAll('th,td')
        .map((cell) => cell.text.replace(/\s+/g, ' ').trim())).filter((row) => row.some(Boolean));
      if (rows.length) blocks.push({ type: 'table', rows });
      continue;
    }
    const text = element.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (/^h[1-6]$/.test(tag)) blocks.push({ type: 'heading', text, level: Number(tag[1]) });
    else if (tag === 'li') blocks.push({ type: 'list-item', text });
    else blocks.push({ type: 'paragraph', text });
  }
  return { version: 1, blocks };
}

function markdownDocument(source: string): CanonicalCvDocument {
  const blocks: CvDocumentBlock[] = [];
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let inFence = false;
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index].trim();
    if (/^```|^~~~/.test(raw)) { inFence = !inFence; continue; }
    if (!raw) continue;
    if (inFence) { blocks.push({ type: 'paragraph', text: raw }); continue; }
    const heading = /^(#{1,6})\s+(.+)$/.exec(raw);
    if (heading) { blocks.push({ type: 'heading', text: cleanInlineMarkdown(heading[2]), level: heading[1].length }); continue; }
    const bullet = /^(?:[-+*]|\d+[.)])\s+(.+)$/.exec(raw);
    if (bullet) { blocks.push({ type: 'list-item', text: cleanInlineMarkdown(bullet[1]) }); continue; }
    if (raw.includes('|') && index + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1])) {
      const rows: string[][] = [];
      const row = (value: string) => value.replace(/^\||\|$/g, '').split('|').map((cell) => cleanInlineMarkdown(cell));
      rows.push(row(raw)); index++;
      while (index + 1 < lines.length && lines[index + 1].includes('|') && lines[index + 1].trim()) rows.push(row(lines[++index]));
      blocks.push({ type: 'table', rows }); continue;
    }
    blocks.push({ type: 'paragraph', text: cleanInlineMarkdown(raw.replace(/^>\s*/, '')) });
  }
  return { version: 1, blocks };
}

export function canonicalDocumentText(document: CanonicalCvDocument): string {
  return document.blocks.map((block) => {
    if (block.type === 'list-item') return `• ${block.text}`;
    if (block.type === 'table') return block.rows.map((row) => row.join(' | ')).join('\n');
    return block.text;
  }).filter(Boolean).join('\n');
}

function decodeText(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('windows-1251').decode(bytes); }
}

function detectFormat(filename: string, mediaType: string | undefined, bytes: Uint8Array): CvSourceFormat {
  if (!bytes.length || bytes.length > maximumCvBytes) throw new Error(`CV document size is invalid (${bytes.length} bytes).`);
  const extension = extname(filename).toLowerCase();
  if (extension && !['.pdf', '.docx', '.md', '.markdown', '.txt'].includes(extension)) {
    throw new Error('Unsupported CV filename extension.');
  }
  const pdfMagic = Buffer.from(bytes.subarray(0, 4)).toString() === '%PDF';
  const zipMagic = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
    && ((bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6));
  if (extension === '.pdf' || mediaType === mediaTypes.pdf) {
    if (!pdfMagic) throw new Error('The uploaded PDF has invalid file content.');
    return 'pdf';
  }
  if (extension === '.docx' || mediaType === mediaTypes.docx) {
    if (!zipMagic) throw new Error('The uploaded DOCX has invalid file content.');
    return 'docx';
  }
  if (pdfMagic || zipMagic) throw new Error('CV filename, media type, and file content do not agree.');
  if (extension === '.md' || extension === '.markdown' || mediaType === mediaTypes.md) return 'md';
  if (extension === '.txt' || mediaType?.startsWith('text/plain')) return 'txt';
  throw new Error('Unsupported CV format. Send PDF, Markdown, TXT, or DOCX.');
}

function validateDocxArchive(bytes: Uint8Array): void {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0; let entries = 0; let compressedTotal = 0; let uncompressedTotal = 0;
  while ((offset = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), offset)) !== -1) {
    if (offset + 46 > buffer.length) throw new Error('DOCX archive directory is truncated.');
    const compressed = buffer.readUInt32LE(offset + 20); const uncompressed = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28); const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    if (compressed === 0xffff_ffff || uncompressed === 0xffff_ffff) throw new Error('ZIP64 DOCX files are not supported.');
    entries++; compressedTotal += compressed; uncompressedTotal += uncompressed;
    if (entries > maximumDocxEntries || uncompressedTotal > maximumDocxUncompressedBytes
      || (compressedTotal > 0 && uncompressedTotal / compressedTotal > maximumDocxCompressionRatio)) {
      throw new Error('DOCX archive exceeds safe expansion limits.');
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (!entries) throw new Error('DOCX archive has no readable directory.');
}

async function extractPdf(bytes: Uint8Array): Promise<Omit<ExtractedCvDocument, 'sourceFormat' | 'mediaType'>> {
  const pdf = await getDocumentProxy(Uint8Array.from(bytes));
  const extracted = await extractText(pdf, { mergePages: true });
  const raw=String(extracted.text);
  if(raw.replace(/\s/g,'').length<100)throw new Error('CV_OCR_REQUIRED: PDF contains no usable text layer. Export it with OCR and upload it again.');
  const text = normalizeText(raw);
  return { text, document: annotateDocument(plainBlocks(text),text), parserName: 'unpdf', parserVersion: '2' };
}
async function extractDocx(bytes: Uint8Array): Promise<Omit<ExtractedCvDocument, 'sourceFormat' | 'mediaType'>> {
  validateDocxArchive(bytes);
  const buffer = Buffer.from(bytes);
  const [raw, html] = await Promise.all([mammoth.extractRawText({ buffer }), mammoth.convertToHtml({ buffer })]);
  const document = htmlDocument(html.value);
  const text = normalizeText(document.blocks.length ? canonicalDocumentText(document) : raw.value);
  return { text, document: annotateDocument(document.blocks.length ? document : plainBlocks(text),text),
    parserName: 'mammoth', parserVersion: '1.12.0' };
}
export async function extractCvDocument(filename: string, mediaType: string | undefined,
  bytes: Uint8Array): Promise<ExtractedCvDocument> {
  const sourceFormat = detectFormat(filename, mediaType, bytes);
  if (sourceFormat === 'pdf') return { ...await extractPdf(bytes), sourceFormat, mediaType: mediaTypes.pdf };
  if (sourceFormat === 'docx') return { ...await extractDocx(bytes), sourceFormat, mediaType: mediaTypes.docx };
  const source = decodeText(bytes);
  if (sourceFormat === 'md') {
    const document = markdownDocument(source);
    const text = normalizeText(canonicalDocumentText(document));
    return { text, document:annotateDocument(document,text), sourceFormat, mediaType: mediaTypes.md, parserName: 'builtin-markdown', parserVersion: '2' };
  }
  const text = normalizeText(source);
  return { text, document: annotateDocument(plainBlocks(text),text), sourceFormat, mediaType: mediaTypes.txt,
    parserName: 'builtin-text', parserVersion: '2' };
}


export type CvLanguage = 'ru' | 'en';

export function detectCvLanguage(text: string): CvLanguage {
  const cyrillic = text.match(/[А-Яа-яЁё]/g)?.length ?? 0;
  const latin = text.match(/[A-Za-z]/g)?.length ?? 0;
  return cyrillic >= 20 && cyrillic >= latin * 0.15 ? 'ru' : 'en';
}
