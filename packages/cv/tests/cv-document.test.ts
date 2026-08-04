import assert from 'node:assert/strict';
import test from 'node:test';
import * as v from 'valibot';
import { cvDocumentSchema, normalizeCvDocumentJson, parseCvText } from '../src/pdf.ts';

const blocksOf = (document: ReturnType<typeof parseCvText>, title: string) =>
  document.sections.find((section) => section.title === title)?.blocks ?? [];

test('an acronym list is content, not a section label', () => {
  const document = parseCvText([
    'Ivan Petrov', 'Backend Engineer', 'Remote | first.last@example.com',
    'TECHNICAL SKILLS', 'SQL, ETL, API, AWS, GCP, CI/CD', 'Stack: Go, Rust',
  ].join('\n'));
  assert.deepEqual(document.sections.map((section) => section.title), ['TECHNICAL SKILLS']);
  assert.equal(blocksOf(document, 'TECHNICAL SKILLS')[0]?.kind, 'text');
});

test('a hard-wrapped paragraph becomes one block, and a blank line starts another', () => {
  const document = parseCvText([
    'Ivan Petrov', 'Backend Engineer', 'Remote', 'SUMMARY',
    'Engineer with eight years of', 'experience building services.', '', 'A separate closing statement.',
  ].join('\n'));
  const blocks = blocksOf(document, 'SUMMARY');
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], { kind: 'text', text: 'Engineer with eight years of experience building services.' });
});

test('bullets attach to the entry they follow, and the trailing dates become its meta', () => {
  const document = parseCvText([
    'Ivan Petrov', 'Backend Engineer', 'Remote', 'EXPERIENCE',
    'Acme Corp — 2020–2024', '• Reduced p99 latency by 40%', '• Migrated CI to GitHub Actions',
  ].join('\n'));
  assert.deepEqual(blocksOf(document, 'EXPERIENCE'), [{
    kind: 'entry', title: 'Acme Corp', meta: '2020–2024',
    bullets: ['Reduced p99 latency by 40%', 'Migrated CI to GitHub Actions'],
  }]);
});

test('a CV with no section labels does not donate its whole body to the contact row', () => {
  const document = parseCvText(['Ivan Petrov', ...Array.from({ length: 40 }, (_, i) => `Line ${i} of prose.`)].join('\n'));
  assert.ok(document.contacts.length <= 8, `contacts: ${document.contacts.length}`);
  assert.ok(document.sections.length >= 1);
});

test('text too short to be a CV is refused rather than laid out', () => {
  assert.throws(() => parseCvText('Ivan Petrov\nBackend Engineer'), /too little content/);
});

const parse = (value: unknown) => v.parse(cvDocumentSchema, (normalizeCvDocumentJson(value) as { cv: unknown }).cv);

test('a drifted document is coerced: type for kind, company/role/period for an entry', () => {
  const document = parse({
    cv: {
      fullName: 'Ivan Petrov', role: 'Backend Engineer', contact: ['Remote'],
      sections: [{ heading: 'EXPERIENCE', blocks: [
        { type: 'entry', company: 'Acme Corp', role: 'Senior Engineer', period: '2020–2024', points: ['Shipped a cache'] },
      ] }],
    },
  });
  assert.equal(document.headline, 'Backend Engineer');
  assert.deepEqual(document.sections[0]?.blocks[0], {
    kind: 'entry', title: 'Acme Corp', subtitle: 'Senior Engineer', meta: '2020–2024', bullets: ['Shipped a cache'],
  });
});

test('a section whose blocks are all unrecognisable is dropped instead of rendering debris', () => {
  assert.throws(() => parse({ cv: { name: 'Ivan Petrov', contacts: [], sections: [{ title: 'EMPTY', blocks: [{}, null] }] } }));
});
