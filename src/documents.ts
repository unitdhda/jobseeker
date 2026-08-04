import { delimiter } from 'node:path';
import { NodeCompiler } from '@myriaddreamin/typst-ts-node-compiler';
import { parseCvText, type CvBlock, type CvDocument } from './cv-document.ts';
import { cvPreamble } from './cv-template.ts';

const fontPaths = (process.env.TYPST_FONT_PATHS ?? '').split(delimiter).filter(Boolean);
const compiler = NodeCompiler.create(fontPaths.length ? { fontArgs: [{ fontPaths }] } : undefined);
const forbidden = /#\s*(?:import|include|read)\b/i;

export function compileTypst(source: string): Buffer {
  if (forbidden.test(source)) {
    throw new Error('Typst source must be self-contained; import, include, and read are forbidden.');
  }
  try {
    const compiled = compiler.compile({ mainFileContent: source });
    const error = compiled.takeError();
    if (error) throw error;
    const document = compiled.result;
    if (!document) throw new Error('Compiler produced no document.');
    const pdf = compiler.pdf(document);
    if (!pdf.length || pdf.subarray(0, 4).toString() !== '%PDF') throw new Error('Compiler returned an invalid PDF.');
    return pdf;
  } catch (error) {
    const shortDiagnostics = error && typeof error === 'object' && 'shortDiagnostics' in error
      ? (error as { shortDiagnostics: unknown }).shortDiagnostics : undefined;
    const diagnostics = shortDiagnostics != null
      ? JSON.stringify(shortDiagnostics)
      : error instanceof Error ? error.message || error.name : String(error) || 'unknown compiler error';
    throw new Error(`Typst compilation failed: ${diagnostics}`, { cause: error });
  }
}

/**
 * Escapes every character Typst treats as markup. The hyphen and tilde matter as much as the brackets: Typst rewrites
 * `--` into an en dash and `~` into a non-breaking space, so a CV that mentioned `CI --- pipeline` used to come out
 * with an em dash and a swallowed tilde. Escaping each one individually is harmless, since `\-` renders as `-`.
 */
function escapeTypst(value: string): string {
  return value.replace(/[\\#\[\]$@<>*_`~\-.]/g, '\\$&');
}

const emphasisPattern = /\*\*([^*]+)\*\*|\*([^*]+)\*/g;

/**
 * Renders one run of text, honouring the only inline markup the contract allows. Emphasis is resolved before escaping
 * so the markers themselves never reach the compiler as literal asterisks.
 */
function inlineContent(value: string): string {
  let result = '';
  let cursor = 0;
  for (const match of value.matchAll(emphasisPattern)) {
    result += escapeTypst(value.slice(cursor, match.index));
    result += match[1] != null ? `#strong[${escapeTypst(match[1])}]` : `#emph[${escapeTypst(match[2]!)}]`;
    cursor = match.index + match[0].length;
  }
  return result + escapeTypst(value.slice(cursor));
}

const content = (value: string): string => `[${inlineContent(value)}]`;
const optional = (value: string | undefined): string => value ? content(value) : 'none';
/** Always trailing-comma: `(x)` is a parenthesised value in Typst and `(k: v)` a dictionary, only `(x,)` is an array. */
const tuple = (items: readonly string[]): string => items.length ? `(${items.join(', ')},)` : '()';
const array = (values: readonly string[]): string => tuple(values.map(content));

function blockContent(block: CvBlock): string {
  switch (block.kind) {
    case 'text': return `#cv-text(${content(block.text)})`;
    case 'bullets': return `#cv-bullets(${array(block.items)})`;
    case 'facts':
      // The template supplies the colon, so a term the model already punctuated must not end up with two.
      return `#cv-facts(${tuple(block.items.map((item) =>
        `(term: ${content(item.term.replace(/\s*:$/, ''))}, detail: ${content(item.detail)})`))})`;
    case 'entry':
      return `#cv-entry(${content(block.title)}, ${optional(block.subtitle)}, ${optional(block.meta)}, `
        + `${optional(block.text)}, ${array(block.bullets ?? [])})`;
  }
}

/** Cyrillic content needs its own quotation marks and hyphenation rules; anything else is treated as English. */
function documentLanguage(document: CvDocument): string {
  const sample = `${document.name} ${document.sections.map((section) => section.title).join(' ')}`;
  return /[Ѐ-ӿ]/.test(sample) ? 'ru' : 'en';
}

function cvSource(document: CvDocument): string {
  const sections = document.sections.map((section) => {
    const blocks = section.blocks.map(blockContent).join('\n  #cv-gap\n  ');
    return `#cv-section(${content(section.title)})[\n  ${blocks}\n]`;
  }).join('\n');
  return `${cvPreamble(documentLanguage(document))}
#cv-header(${content(document.name)}, ${optional(document.headline)}, ${array(document.contacts)})
${sections}
`;
}

/**
 * One compilation, one page. The page height follows the content, so there is no stranded trailing page to fit away
 * and no reason to shrink the type: what used to be a density search is now the layout's own job.
 */
export function compileCvDocument(document: CvDocument): Buffer {
  return compileTypst(cvSource(document));
}

/** Kept for callers that still hold plain text: it recovers the structure first, then takes the same path. */
export function compilePlainTextCv(text: string): Buffer {
  return compileCvDocument(parseCvText(text));
}

export interface GeneratedApplication {
  tailoredCvPdf: Buffer;
  coverLetter: string;
}

const staged = new Map<string, GeneratedApplication>();
const key = (userId: string, vacancyId: number): string => `${userId}:${vacancyId}`;

export function stageApplicationArtifacts(userId: string, vacancyId: number, artifacts: GeneratedApplication): void {
  staged.set(key(userId, vacancyId), artifacts);
}

export function getApplicationArtifacts(userId: string, vacancyId: number): GeneratedApplication | null {
  return staged.get(key(userId, vacancyId)) ?? null;
}

export function clearApplicationArtifacts(userId: string, vacancyId: number): void {
  staged.delete(key(userId, vacancyId));
}
