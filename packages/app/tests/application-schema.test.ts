import assert from 'node:assert/strict';
import test from 'node:test';
import { parseApplicationOutput } from '../src/application-schema.ts';

test('structured CV output repairs contact objects and block drift', () => {
  const parsed = parseApplicationOutput({ artifact: 'cv', document: {
    name: 'Ada Lovelace',
    contacts: [{ value: 'ada@example.test' }],
    sections: [{ title: 'Experience', blocks: [{ type: 'entry', employer: 'Analytical Engines', points: ['Built systems'] }] }],
  } }, 'cv');
  assert.equal(parsed.artifact, 'cv');
  if (parsed.artifact !== 'cv') return;
  assert.equal(parsed.source, 'structured');
  assert.deepEqual(parsed.document.contacts, ['ada@example.test']);
  assert.deepEqual(parsed.document.sections[0]!.blocks[0], {
    kind: 'entry', title: 'Analytical Engines', bullets: ['Built systems'],
  });
});

test('prose CV fallback uses the conservative structured salvage path', () => {
  const text = `Ada Lovelace\nSoftware Engineer\n\nEXPERIENCE\nAnalytical Engines 2020–2024\nBuilt deterministic analytical systems and documented reusable engineering evidence for production teams.\n`;
  const parsed = parseApplicationOutput({ artifact: 'cv', text }, 'cv');
  assert.equal(parsed.artifact, 'cv');
  if (parsed.artifact !== 'cv') return;
  assert.equal(parsed.source, 'prose');
  assert.equal(parsed.document.name, 'Ada Lovelace');
  assert.equal(parsed.document.sections[0]!.title, 'EXPERIENCE');
});

test('cover letter is independent, bounded plain text with no document output', () => {
  const text = `My production experience building deterministic analytical systems matches the role's core requirements.\n\nI can contribute tested TypeScript and PostgreSQL work while communicating concrete trade-offs with the team.`;
  const parsed = parseApplicationOutput({ artifact: 'letter', text }, 'letter');
  assert.deepEqual(parsed, { artifact: 'letter', text });
  assert.equal('document' in parsed, false);
  assert.throws(() => parseApplicationOutput({ artifact: 'cv', text }, 'letter'));
  assert.throws(() => parseApplicationOutput({ artifact: 'letter', text }, 'cv'));
});

test('cover letter rejects Markdown, excess paragraphs, salutations, and signature blocks', () => {
  const validParagraph = 'Concrete production evidence demonstrates a close match for the role and its technical requirements.';
  for (const text of [
    `# Heading\n\n${validParagraph}`,
    [validParagraph, validParagraph, validParagraph, validParagraph].join('\n\n'),
    `Dear Hiring Manager,\n\n${validParagraph}`,
    `${validParagraph}\n\nSincerely,\nAda`,
  ]) assert.throws(() => parseApplicationOutput({ artifact: 'letter', text }, 'letter'));
});
