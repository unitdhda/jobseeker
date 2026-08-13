import { NodeCompiler } from '@myriaddreamin/typst-ts-node-compiler';
import { parseCvText, type CvBlock, type CvDocument } from './document.ts';
import { detectCvLanguage } from './extract.ts';
import { cvPreamble } from './template.ts';

export interface CvPdfOptions {
  readonly fontPaths?: readonly string[];
}

export interface CvPdf {
  compileTypst(source: string): Buffer;
  compileCvDocument(document: CvDocument): Buffer;
  compilePlainTextCv(text: string): Buffer;
}

interface CompiledTypst {
  readonly pdf: Buffer;
  readonly pages: number;
}

export interface CvCompilerAdapter {
  compile(source: string): CompiledTypst;
}

const fittingDensities = [0.96, 0.93, 0.90, 0.87, 0.84, 0.82] as const;

function typstString(value: string): string {
  let result = '"';
  for (const character of value.normalize('NFC')) {
    const code = character.codePointAt(0)!;
    if (character === '"') result += '\\"';
    else if (character === '\\') result += '\\\\';
    else if (character === '\n') result += '\\n';
    else if (character === '\r') result += '\\r';
    else if (character === '\t') result += '\\t';
    else if (code < 0x20 || code === 0x7f) result += `\\u{${code.toString(16)}}`;
    else result += character;
  }
  return `${result}"`;
}

function typstTuple(values: readonly string[]): string {
  return `(${values.map((value) => `${value},`).join('')})`;
}

type InlinePart = { readonly text: string; readonly emphasis: 'plain' | 'bold' | 'italic' };

function inlineParts(value: string): InlinePart[] {
  const parts: InlinePart[] = [];
  let plain = '';
  const flush = (): void => {
    if (plain) parts.push({ text: plain, emphasis: 'plain' });
    plain = '';
  };
  for (let index = 0; index < value.length;) {
    if (value.startsWith('**', index)) {
      const end = value.indexOf('**', index + 2);
      if (end >= 0) {
        flush();
        parts.push({ text: value.slice(index + 2, end), emphasis: 'bold' });
        index = end + 2;
        continue;
      }
    }
    if (value[index] === '*') {
      const end = value.indexOf('*', index + 1);
      if (end >= 0) {
        flush();
        parts.push({ text: value.slice(index + 1, end), emphasis: 'italic' });
        index = end + 1;
        continue;
      }
    }
    plain += value[index]!;
    index += 1;
  }
  flush();
  return parts;
}

/** Inline content is a fixed expression tree; only bold and italic markers can create Typst markup. */
function inlineContent(value: string): string {
  const parts = inlineParts(value).filter((part) => part.text.length > 0);
  if (parts.length === 0) return '[]';
  return `[${parts.map((part) => {
    const literal = typstString(part.text);
    if (part.emphasis === 'bold') return `#text(weight: "bold", ${literal})`;
    if (part.emphasis === 'italic') return `#emph(${literal})`;
    return `#${literal}`;
  }).join('')}]`;
}

function optionalContent(value: string | undefined): string {
  return value === undefined ? 'none' : inlineContent(value);
}

function blockSource(block: CvBlock): string {
  switch (block.kind) {
    case 'text':
      return `#cv-text(${inlineContent(block.text)})`;
    case 'bullets':
      return `#cv-list(${typstTuple(block.items.map(inlineContent))})`;
    case 'entry':
      return `#cv-entry(${inlineContent(block.title)}, subtitle: ${optionalContent(block.subtitle)}, meta: ${optionalContent(block.meta)}, body: ${optionalContent(block.text)}, bullets: ${typstTuple((block.bullets ?? []).map(inlineContent))})`;
    case 'facts':
      return `#cv-facts(${typstTuple(block.items.map((fact) => typstTuple([
        inlineContent(fact.term), inlineContent(fact.detail),
      ])))})`;
  }
}

function codeWithoutStringsOrComments(source: string): string {
  let output = '';
  let index = 0;
  while (index < source.length) {
    if (source.startsWith('//', index)) {
      const end = source.indexOf('\n', index + 2);
      index = end < 0 ? source.length : end;
      output += '\n';
      continue;
    }
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      index = end < 0 ? source.length : end + 2;
      output += ' ';
      continue;
    }
    if (source[index] === '"') {
      output += '""';
      index += 1;
      while (index < source.length) {
        if (source[index] === '\\') { index += 2; continue; }
        if (source[index] === '"') { index += 1; break; }
        index += 1;
      }
      continue;
    }
    output += source[index]!;
    index += 1;
  }
  return output;
}

function assertSafeTypst(source: string): void {
  const code = codeWithoutStringsOrComments(source);
  if (/(^|[^\p{L}\p{N}_])(?:import|include|read)\s*\(/iu.test(code)) {
    throw new TypeError('Unsafe Typst source: import, include, and read calls are forbidden.');
  }
}

/** Serializes a validated document into calls to the fixed template component library only. */
export function cvSource(document: CvDocument, density: number): string {
  const evidenceText = [
    document.name,
    document.headline ?? '',
    ...document.contacts,
    ...document.sections.flatMap((section) => [section.title, ...section.blocks.flatMap((block) => {
      if (block.kind === 'text') return [block.text];
      if (block.kind === 'bullets') return block.items;
      if (block.kind === 'facts') return block.items.flatMap((fact) => [fact.term, fact.detail]);
      return [block.title, block.subtitle ?? '', block.meta ?? '', block.text ?? '', ...(block.bullets ?? [])];
    })]),
  ].join('\n');
  const language = detectCvLanguage(evidenceText);
  const contacts = typstTuple(document.contacts.map((contact) => inlineContent(contact)));
  const sections = document.sections.map((section) => {
    const body = section.blocks.map(blockSource).join('\n');
    return `#cv-section(${inlineContent(section.title)}, [${body}])`;
  }).join('\n');
  const source = `${cvPreamble(density, language)}
#cv-header(${inlineContent(document.name)}, headline: ${optionalContent(document.headline)}, contacts: ${contacts})
${sections}
`;
  assertSafeTypst(source);
  return source;
}

function realCompiler(options: CvPdfOptions): CvCompilerAdapter {
  const compiler = NodeCompiler.create({
    ...(options.fontPaths?.length
      ? { fontArgs: [{ fontPaths: [...options.fontPaths] }] }
      : {}),
  });
  return {
    compile(source: string): CompiledTypst {
      assertSafeTypst(source);
      const execution = compiler.compile({ mainFileContent: source });
      if (execution.hasError() || !execution.result) {
        const diagnostics = execution.takeDiagnostics() ?? execution.takeError();
        const count = diagnostics?.shortDiagnostics.length ?? 0;
        throw new Error(`Typst compilation failed with ${count || 'unknown'} diagnostic errors.`);
      }
      const pdf = compiler.pdf(execution.result);
      if (pdf.subarray(0, 4).toString('ascii') !== '%PDF') {
        throw new Error('Typst compiler returned output without a PDF signature.');
      }
      return { pdf, pages: execution.result.numOfPages };
    },
  };
}

/** Internal adapter seam keeps density fitting deterministic in tests without widening the public PDF API. */
export function createCvPdfWithCompiler(compiler: CvCompilerAdapter): CvPdf {
  const compileTypst = (source: string): Buffer => compiler.compile(source).pdf;
  const compileCvDocument = (document: CvDocument): Buffer => {
    const natural = compiler.compile(cvSource(document, 1));
    if (natural.pages <= 1) return natural.pdf;
    for (const density of fittingDensities) {
      const candidate = compiler.compile(cvSource(document, density));
      if (candidate.pages < natural.pages) return candidate.pdf;
    }
    return natural.pdf;
  };
  return Object.freeze({
    compileTypst,
    compileCvDocument,
    compilePlainTextCv: (text: string) => compileCvDocument(parseCvText(text)),
  });
}

export function createCvPdf(options: CvPdfOptions = {}): CvPdf {
  return createCvPdfWithCompiler(realCompiler(options));
}
