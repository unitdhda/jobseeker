import assert from 'node:assert/strict';
import test from 'node:test';
import * as v from 'valibot';
import {
  cvDocumentSchema,
  normalizeCvDocumentJson,
  parseCvText,
} from '../src/document.ts';
import {
  canonicalDocumentText,
  CvExtractionError,
  detectCvLanguage,
  detectCvSourceFormat,
  extractCvDocument,
} from '../src/extract.ts';

test('strict schema enforces bounded structured CV documents', () => {
  assert.throws(() => v.parse(cvDocumentSchema, {
    name: 'Ada Lovelace', contacts: [], sections: [], unknown: true,
  }));
  assert.throws(() => v.parse(cvDocumentSchema, {
    name: 'Ada Lovelace', contacts: Array.from({ length: 9 }, () => 'contact'), sections: [],
  }));
});

test('repair unwraps model envelopes and coerces contacts, entries, facts, and strings', () => {
  const repaired = normalizeCvDocumentJson({ document: {
    name: ' Ada Lovelace ',
    headline: ' Engineer ',
    contacts: [{ label: 'ada@example.test' }, { url: 'https://example.test' }],
    sections: [{ name: 'Experience', items: [
      { type: 'entry', employer: 'Analytical Engines', role: 'Engineer', dates: '2020–2024', points: ['Built systems'] },
      'Additional context',
      { type: 'facts', facts: { Language: 'English' } },
      { debris: true },
    ] }],
  } });
  const document = v.parse(cvDocumentSchema, repaired);
  assert.deepEqual(document.contacts, ['ada@example.test', 'https://example.test']);
  assert.deepEqual(document.sections[0]!.blocks, [
    { kind: 'entry', title: 'Analytical Engines', subtitle: 'Engineer', meta: '2020–2024', bullets: ['Built systems'] },
    { kind: 'text', text: 'Additional context' },
    { kind: 'facts', items: [{ term: 'Language', detail: 'English' }] },
  ]);
});

test('prose salvage discriminates headings, merges wrapping, and attaches bullets to entries', () => {
  const source = `Ada Lovelace
Software Engineer

EXPERIENCE
Analytical Engines 2020–2024
- Built a deterministic calculation system
- Documented algorithms for other engineers

Designed a reusable computation pipeline that continued
across a hard-wrapped source line without a blank separator.

SKILLS
Languages: TypeScript, SQL
Platforms: PostgreSQL, Kubernetes

SQL AWS API
This acronym line remains body evidence rather than a heading.
`;
  const document = parseCvText(source);
  assert.equal(document.name, 'Ada Lovelace');
  assert.equal(document.headline, 'Software Engineer');
  const experience = document.sections.find((section) => section.title === 'EXPERIENCE')!;
  assert.deepEqual(experience.blocks[0], {
    kind: 'entry', title: 'Analytical Engines', meta: '2020–2024',
    bullets: ['Built a deterministic calculation system', 'Documented algorithms for other engineers'],
  });
  assert.deepEqual(experience.blocks[1], {
    kind: 'text',
    text: 'Designed a reusable computation pipeline that continued across a hard-wrapped source line without a blank separator.',
  });
  const skills = document.sections.find((section) => section.title === 'SKILLS')!;
  assert.equal(skills.blocks[0]!.kind, 'facts');
  assert.equal(skills.blocks[1]!.kind, 'text');
  assert.deepEqual(document.contacts, []);
});

test('format detection requires extension, explicit media type, and binary magic to agree', () => {
  const pdf = new TextEncoder().encode('%PDF-1.7');
  assert.equal(detectCvSourceFormat('cv.pdf', 'application/pdf', pdf), 'pdf');
  assert.throws(() => detectCvSourceFormat('cv.txt', 'text/plain', pdf), (error) =>
    error instanceof CvExtractionError && error.code === 'CV_FORMAT_MISMATCH');
  assert.throws(() => detectCvSourceFormat('cv.exe', 'application/octet-stream', new Uint8Array()), (error) =>
    error instanceof CvExtractionError && error.code === 'CV_UNSUPPORTED_FORMAT');
});

test('Markdown extraction produces reusable annotated canonical blocks', async () => {
  const markdown = `# Ada Lovelace\n\n## Experience 2020–2024\n\nBuilt **deterministic** analytical systems and documented reusable algorithms for engineering teams.\n\n- Designed computation pipelines\n- Reviewed mathematical evidence\n\n| Skill | Evidence |\n| --- | --- |\n| TypeScript | Production systems |\n`;
  const extracted = await extractCvDocument('cv.markdown', 'text/markdown', new TextEncoder().encode(markdown));
  assert.equal(extracted.sourceFormat, 'md');
  assert.equal(extracted.document.blocks[0]?.type, 'heading');
  assert.ok(extracted.document.blocks.every((block) => block.source && block.source.end > block.source.start));
  assert.equal(extracted.text, canonicalDocumentText(extracted.document));
  assert.doesNotMatch(extracted.text, /\*\*/u);
});

test('plain-text extraction falls back to Windows-1251 and detects meaningful Russian evidence', async () => {
  const cp1251Heading = Uint8Array.from([0xcf, 0xd0, 0xce, 0xd4, 0xc8, 0xcb, 0xdc]); // ПРОФИЛЬ
  const body = new TextEncoder().encode(` 2020–2024\n${'Built deterministic systems and documented engineering evidence. '.repeat(3)}`);
  const encoded = new Uint8Array(cp1251Heading.length + body.length);
  encoded.set(cp1251Heading);
  encoded.set(body, cp1251Heading.length);
  const extracted = await extractCvDocument('cv.txt', 'text/plain', encoded);
  assert.equal(extracted.sourceFormat, 'txt');
  assert.match(extracted.text, /ПРОФИЛЬ/u);

  const russian = `ИВАН ИВАНОВ\nОПЫТ РАБОТЫ\nРазрабатывал надежные программные системы и документировал технические решения для команды.`;
  assert.equal(detectCvLanguage(russian), 'ru');
  assert.equal(detectCvLanguage('Short English curriculum vitae with no meaningful Cyrillic evidence.'), 'en');
});

test('fallback preserves an unstructured body without donating it to contacts', () => {
  const document = parseCvText(`This curriculum vitae has no obvious personal-name header and begins with a descriptive sentence.
It continues across several hard-wrapped lines so the parser has enough meaningful source content to preserve safely.

Another paragraph describes verified employment evidence and technical work without pretending to infer structure.
`);
  assert.equal(document.name, 'Curriculum Vitae');
  assert.deepEqual(document.contacts, []);
  assert.equal(document.sections[0]!.title, 'Profile');
  assert.equal(document.sections[0]!.blocks[0]!.kind, 'text');
});
