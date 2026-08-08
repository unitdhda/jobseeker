import assert from 'node:assert/strict';
import test from 'node:test';
import * as v from 'valibot';
import { cvDocumentLimits, cvDocumentSchema, normalizeCvDocumentJson, parseCvText } from '../src/pdf.ts';

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

test('repair clips every count the schema caps, so an over-long CV still lays out', () => {
  const many = (count: number, make: (index: number) => unknown): unknown[] =>
    Array.from({ length: count }, (_, index) => make(index));
  const oversized = {
    cv: {
      name: 'Ivan Petrov',
      contacts: many(12, (index) => `contact-${index}@example.com`),
      sections: many(18, (index) => ({
        title: `SECTION ${index}`,
        blocks: [
          { kind: 'bullets', items: many(37, (item) => `Shipped feature ${item}`) },
          { kind: 'facts', items: many(26, (item) => ({ term: `Group ${item}`, detail: 'A, B, C' })) },
          ...many(48, (block) => ({ kind: 'text', text: `Paragraph ${block}` })),
        ],
      })),
    },
  };
  // The raw document is rejected outright; repaired, it validates and keeps its leading content in order.
  assert.equal(v.safeParse(cvDocumentSchema, oversized.cv).success, false);
  const document = parse(oversized);
  assert.equal(document.contacts.length, cvDocumentLimits.contacts);
  assert.equal(document.sections.length, cvDocumentLimits.sections);
  assert.equal(document.sections[0]!.title, 'SECTION 0');
  assert.equal(document.sections[0]!.blocks.length, cvDocumentLimits.blocksPerSection);
  const bullets = document.sections[0]!.blocks[0]!;
  assert.equal(bullets.kind === 'bullets' && bullets.items.length, cvDocumentLimits.bullets);
  const facts = document.sections[0]!.blocks[1]!;
  assert.equal(facts.kind === 'facts' && facts.items.length, cvDocumentLimits.facts);
});
