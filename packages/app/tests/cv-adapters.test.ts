import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createCvPdf } from '@jobseeker/cv/pdf';
import {
  bunCvParserCommand,
  createCvParser,
  CvParserProcessError,
} from '../src/cv.ts';

const workerPath = resolve(dirname(fileURLToPath(import.meta.url)), '../src/cv-worker.ts');
const home = typeof process.env.HOME === 'string' ? process.env.HOME : '.';
const path = typeof process.env.PATH === 'string' ? process.env.PATH : '';
const bunExecutable: string = process.execPath.includes('bun')
  ? process.execPath
  : resolve(home, '.bun/bin/bun');
const command = bunCvParserCommand(bunExecutable, workerPath, { PATH: path, HOME: home });

const longText = 'Built deterministic systems and documented reusable engineering evidence for production teams. '.repeat(3);

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function uint16(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}
function uint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}
function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

/** Minimal stored-entry ZIP writer keeps the DOCX fixture deterministic without a production ZIP dependency. */
function storedZip(entries: readonly { readonly name: string; readonly value: string }[]): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const directoryParts: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const value = encoder.encode(entry.value);
    const crc = crc32(value);
    const local = concatBytes([
      uint32(0x04034b50), uint16(20), uint16(0), uint16(0), uint16(0), uint16(0),
      uint32(crc), uint32(value.length), uint32(value.length), uint16(name.length), uint16(0), name, value,
    ]);
    localParts.push(local);
    directoryParts.push(concatBytes([
      uint32(0x02014b50), uint16(20), uint16(20), uint16(0), uint16(0), uint16(0), uint16(0),
      uint32(crc), uint32(value.length), uint32(value.length), uint16(name.length), uint16(0), uint16(0),
      uint16(0), uint16(0), uint32(0), uint32(offset), name,
    ]));
    offset += local.length;
  }
  const directory = concatBytes(directoryParts);
  return concatBytes([
    ...localParts,
    directory,
    uint32(0x06054b50), uint16(0), uint16(0), uint16(entries.length), uint16(entries.length),
    uint32(directory.length), uint32(offset), uint16(0),
  ]);
}

function docxFixture(): Uint8Array {
  const escaped = longText.replace(/&/gu, '&amp;').replace(/</gu, '&lt;');
  return Uint8Array.from(storedZip([
    { name: '[Content_Types].xml', value: `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>` },
    { name: '_rels/.rels', value: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: 'word/document.xml', value: `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Experience 2020–2024</w:t></w:r></w:p><w:p><w:r><w:t>${escaped}</w:t></w:r></w:p></w:body></w:document>` },
  ]));
}

const pdfFixture = (): Uint8Array => Uint8Array.from(createCvPdf().compileCvDocument({
  name: 'Ada Lovelace', contacts: [], sections: [{ title: 'Experience', blocks: [{ kind: 'text', text: longText }] }],
}));

const fixtures = [
  { filename: 'cv.txt', mediaType: 'text/plain', bytes: new TextEncoder().encode(`PROFILE 2020–2024\n${longText}`), format: 'txt' },
  { filename: 'cv.md', mediaType: 'text/markdown', bytes: new TextEncoder().encode(`# Profile 2020–2024\n\n${longText}`), format: 'md' },
  { filename: 'cv.pdf', mediaType: 'application/pdf', bytes: pdfFixture(), format: 'pdf' },
  { filename: 'cv.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: docxFixture(), format: 'docx' },
] as const;

test('isolated parser extracts all four reusable annotated CV formats', async () => {
  const parser = createCvParser({ command });
  for (const fixture of fixtures) {
    const result = await parser.parse(fixture.filename, fixture.mediaType, fixture.bytes);
    assert.equal(result.extraction.sourceFormat, fixture.format);
    assert.ok(result.extraction.text.length >= 100);
    assert.ok(result.extraction.document.blocks.length > 0);
    assert.ok(result.extraction.document.blocks.every((block) => block.source?.end));
    assert.equal(result.preview.filename, fixture.filename);
    assert.match(result.preview.sha256, /^[0-9a-f]{64}$/u);
    assert.equal(result.preview.excerpt, result.extraction.text.slice(0, 700));
  }
});

test('isolated parser preserves format mismatch diagnostics', async () => {
  const parser = createCvParser({ command });
  await assert.rejects(
    parser.parse('cv.txt', 'text/plain', pdfFixture()),
    (error) => error instanceof CvParserProcessError && error.code === 'CV_FORMAT_MISMATCH',
  );
});

test('parser concurrency is bounded and every timeout path releases its slot', async () => {
  const parser = createCvParser({ command, concurrency: 2, timeoutMs: 30_000 });
  const requests = fixtures.slice(0, 3).map((fixture) => parser.parse(fixture.filename, fixture.mediaType, fixture.bytes));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(parser.activeCount <= 2);
  assert.ok(parser.pendingCount <= 1);
  await Promise.all(requests);
  assert.equal(parser.activeCount, 0);
  assert.equal(parser.pendingCount, 0);

  const timingOut = createCvParser({ command, concurrency: 1, timeoutMs: 1 });
  await assert.rejects(
    timingOut.parse(fixtures[0].filename, fixtures[0].mediaType, fixtures[0].bytes),
    (error) => error instanceof CvParserProcessError && error.code === 'CV_PARSER_TIMEOUT',
  );
  assert.equal(timingOut.activeCount, 0);
  assert.equal(timingOut.pendingCount, 0);
});
