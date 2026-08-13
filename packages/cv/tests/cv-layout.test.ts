import assert from 'node:assert/strict';
import test from 'node:test';
import type { CvDocument } from '../src/document.ts';
import {
  createCvPdf,
  createCvPdfWithCompiler,
  cvSource,
  type CvCompilerAdapter,
} from '../src/render.ts';
import { extractText } from 'unpdf';

const document: CvDocument = {
  name: 'Ada #Lovelace [Engineer]',
  headline: 'Built **analytical** and *deterministic* systems',
  contacts: ['ada@example.test'],
  sections: [{
    title: 'Experience',
    blocks: [
      { kind: 'entry', title: 'Analytical Engines', meta: '2020–2024', text: 'Designed $safe {systems}.', bullets: ['One item'] },
      { kind: 'facts', items: [{ term: 'Skill', detail: 'TypeScript' }] },
    ],
  }],
};

test('Typst source escapes punctuation and emits only fixed component calls', () => {
  const source = cvSource(document, 1);
  assert.match(source, /#cv-header\(/u);
  assert.match(source, /#cv-section\(/u);
  assert.match(source, /#text\(weight: "bold"/u);
  assert.match(source, /#emph\(/u);
  assert.match(source, /\(\[#"One item"\],\)/u); // one-element content tuples retain a trailing comma
  assert.doesNotMatch(source, /#(?:import|include|read)\s*\(/iu);
  assert.match(source, /Ada #Lovelace \[Engineer\]/u);
});

test('native PDF compilation preserves every representative content fragment', async () => {
  const pdf = createCvPdf().compileCvDocument(document);
  assert.equal(pdf.subarray(0, 4).toString('ascii'), '%PDF');
  const extracted = await extractText(new Uint8Array(pdf), { mergePages: true });
  const text = extracted.text.replace(/\s+/gu, ' ');
  for (const fragment of [
    'Ada #Lovelace [Engineer]', 'analytical', 'deterministic', 'Analytical Engines',
    '2020–2024', 'Designed $safe {systems}.', 'One item', 'TypeScript',
  ]) assert.ok(text.includes(fragment), `missing PDF text fragment: ${fragment}`);
});

test('density fitting accepts the first candidate that reduces page count', () => {
  const densities: number[] = [];
  const compiler: CvCompilerAdapter = {
    compile(source) {
      const density = Number(/#set text\(font: "Spectral", size: (\d+\.\d+) \*/u.exec(source)?.[1]);
      densities.push(density);
      const pages = density >= 0.93 ? 3 : 2;
      return { pdf: Buffer.from(`%PDF-${density}`), pages };
    },
  };
  const pdf = createCvPdfWithCompiler(compiler).compileCvDocument(document);
  assert.deepEqual(densities, [1, 0.96, 0.93, 0.9]);
  assert.equal(pdf.toString(), '%PDF-0.9');
});

test('natural layout is retained when compression does not reduce page count', () => {
  const compiler: CvCompilerAdapter = {
    compile(source) {
      const density = Number(/#set text\(font: "Spectral", size: (\d+\.\d+) \*/u.exec(source)?.[1]);
      return { pdf: Buffer.from(`%PDF-${density}`), pages: 2 };
    },
  };
  assert.equal(createCvPdfWithCompiler(compiler).compileCvDocument(document).toString(), '%PDF-1');
});

test('plain-text rendering uses the structured salvage path', () => {
  let compiled = '';
  const compiler: CvCompilerAdapter = {
    compile(source) { compiled = source; return { pdf: Buffer.from('%PDF-plain'), pages: 1 }; },
  };
  const prose = `Ada Lovelace\nSoftware Engineer\n\nEXPERIENCE\nAnalytical Engines 2020–2024\nBuilt deterministic analytical systems and documented reusable engineering evidence for teams.\n`;
  const pdf = createCvPdfWithCompiler(compiler).compilePlainTextCv(prose);
  assert.equal(pdf.toString(), '%PDF-plain');
  assert.match(compiled, /Ada Lovelace/u);
  assert.match(compiled, /Analytical Engines/u);
});
