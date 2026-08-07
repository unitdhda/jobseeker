import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import test from 'node:test';
import { extractCvDocument } from '../src/cv.ts';
import { extractCvDocumentIsolated } from '../src/cv.ts';
import { compilePlainTextCv } from '../src/documents.ts';

const content = 'Experienced engineer with extensive delivery ownership, architecture, mentoring, testing, operations, quality, and product collaboration.';
function wordDocument(): Buffer {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`));
  zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`));
  zip.addFile('word/document.xml', Buffer.from(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${content} ${content}</w:t></w:r></w:p></w:body></w:document>`));
  return zip.toBuffer();
}

test('PDF, Markdown, TXT, and DOCX adapters produce reusable content', async () => {
  const txt = await extractCvDocument('cv.txt', 'text/plain', new TextEncoder().encode(`${content}\n${content}`));
  const md = await extractCvDocument('cv.md', 'text/markdown', new TextEncoder().encode(`# Candidate\n\n## Experience\n\n- ${content}\n- ${content}`));
  const pdfBytes = compilePlainTextCv(`Candidate Name\nEngineer\nmail@example.com\nPROFILE\n${content}\nEXPERIENCE\n• ${content}`);
  const pdf = await extractCvDocument('cv.pdf', 'application/pdf', pdfBytes);
  const docxBytes = wordDocument();
  const docx = await extractCvDocument('cv.docx', undefined, docxBytes);
  const isolated = await extractCvDocumentIsolated('cv.txt', 'text/plain',
    new TextEncoder().encode(`${content}\n${content}`));
  const results = [txt, md, pdf, docx, isolated];
  assert.deepEqual(results.map((result) => result.sourceFormat), ['txt', 'md', 'pdf', 'docx', 'txt']);
  assert.ok(results.every((result) => result.text.length >= 100 && result.document.blocks.length > 0));
  assert.ok(md.document.blocks.some((block) => block.type === 'heading'));
  await assert.rejects(() => extractCvDocument('fake.pdf', 'application/pdf', docxBytes), /invalid file content/);
  await assert.rejects(() => extractCvDocument('legacy.doc', 'application/msword', docxBytes), /Unsupported CV filename/);
});
