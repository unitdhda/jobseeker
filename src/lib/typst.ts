import { delimiter } from 'node:path';
import { NodeCompiler } from '@myriaddreamin/typst-ts-node-compiler';

const fontPaths = (process.env.TYPST_FONT_PATHS ?? '').split(delimiter).filter(Boolean);
const compiler = NodeCompiler.create(fontPaths.length ? { fontArgs: [{ fontPaths }] } : undefined);
const forbidden = /#\s*(?:import|include|read)\b/i;

export function compileTypst(source: string): Buffer {
  if (forbidden.test(source)) {
    throw new Error('Typst source must be self-contained; import, include, and read are forbidden.');
  }
  try {
    const pdf = compiler.pdf({ mainFileContent: source });
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

function escapeTypst(value: string): string {
  return value.replace(/[\\#\[\]$@<>*_`]/g, '\\$&');
}

export function compilePlainTextCv(text: string): Buffer {
  const lines = text.replaceAll('\r', '').split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length < 5) throw new Error('Tailored CV text contains too little content.');

  const styledInline = (line: string): string => {
    const separator = line.includes(' — ') ? ' — ' : line.includes(': ') ? ': ' : undefined;
    if (!separator) return escapeTypst(line);
    const index = line.indexOf(separator);
    return `#text(weight: 700)[${escapeTypst(line.slice(0, index))}]${escapeTypst(line.slice(index))}`;
  };
  let currentSection = '';
  let afterWorkHeader = false;
  const body = lines.map((line, index) => {
    const escaped = escapeTypst(line);
    if (index === 0) {
      return `#block(below: 30pt)[#text(font: "PragmataPro Liga", size: 21pt, fill: rgb(190, 94, 70), stroke: 0.22pt + rgb(190, 94, 70))[${escaped}]]`;
    }
    if (index === 1) return `#block(below: 14pt)[#text(size: 10.5pt)[${escaped}]]`;
    if (index === 2) return `#block(below: 2pt)[#text(size: 9.2pt)[${escaped}]]`;

    const letters = line.match(/[A-Za-zА-Яа-яЁё]/g)?.length ?? 0;
    const uppercase = line.match(/[A-ZА-ЯЁ]/g)?.length ?? 0;
    if (letters >= 4 && uppercase / letters > 0.8 && line.length < 80) {
      currentSection = line;
      return `#block(above: 13pt, below: 7pt)[#text(font: "PragmataPro Liga", size: 10.5pt, fill: rgb(190, 94, 70), stroke: 0.12pt + rgb(190, 94, 70))[${escaped}]]`;
    }
    if (/^[•\-–—]/.test(line)) {
      const bullet = escapeTypst(line.replace(/^[•\-–—]\s*/, ''));
      const above = afterWorkHeader ? 5 : 0;
      afterWorkHeader = false;
      return `#block(inset: (left: 20pt), above: ${above}pt, below: 4.5pt)[#h(-8pt)• #h(2pt)${bullet}]`;
    }
    if (line.length < 120 && /\|/.test(line)) {
      afterWorkHeader = true;
      return `#block(above: 8pt, below: 1.5pt)[#text(weight: 700)[${escaped}]]`;
    }
    afterWorkHeader = false;
    const below = /(?:ТЕХНИЧЕСКИЕ НАВЫКИ|TECHNICAL SKILLS)/.test(currentSection) ? 6
      : /(?:ПРОЕКТЫ|PROJECTS)/.test(currentSection) ? 13 : 5;
    return `#block(above: 0pt, below: ${below}pt)[${styledInline(line)}]`;
  }).join('\n');

  return compileTypst(`#set page(width: 612pt, height: 792pt, margin: (top: 31pt, bottom: 28pt, left: 48pt, right: 48pt))
#set text(font: "Spectral", size: 9.5pt)
#set par(justify: false, leading: 0.65em, spacing: 0em)
${body}`);
}
