import assert from 'node:assert/strict';
import test from 'node:test';
import { extractText, getDocumentProxy } from '../src/extract.ts';
import { createCvPdf, type CvDocument } from '../src/pdf.ts';

const renderer = createCvPdf();

const document = (...sections: CvDocument['sections']): CvDocument =>
  ({ name: 'Ivan Petrov', headline: 'Backend Engineer', contacts: ['Remote', 'first.last@example.com'], sections });

async function render(cv: CvDocument): Promise<{ text: string; pages: number; height: number }> {
  const pdf = renderer.compileCvDocument(cv);
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  const proxy = await getDocumentProxy(Uint8Array.from(pdf));
  const { text } = await extractText(proxy, { mergePages: true });
  const [, , , height] = (await proxy.getPage(1)).view as number[];
  return { text: String(text).replace(/\s+/g, ' '), pages: proxy.numPages, height: height! };
}

const filler = (count: number): string[] => Array.from({ length: count }, (_, index) =>
  `Delivered workstream ${index} with measured impact on latency, cost and reliability.`);

test('every part of the document reaches the page', async () => {
  const { text } = await render(document(
    { title: 'SUMMARY', blocks: [{ kind: 'text', text: 'Eight years of backend work.' }] },
    { title: 'EXPERIENCE', blocks: [{ kind: 'entry', title: 'Acme Corp', subtitle: 'Senior Engineer',
      meta: '2020-2024', bullets: ['Reduced p99 latency by 40%'] }] },
    { title: 'SKILLS', blocks: [{ kind: 'facts', items: [{ term: 'Stack', detail: 'Go, Rust' }] }] },
  ));
  for (const fragment of ['Ivan Petrov', 'Backend Engineer', 'first.last@example.com', 'SUMMARY',
    'Eight years of backend work.', 'Acme Corp', 'Senior Engineer', '2020-2024', 'Reduced p99 latency by 40%',
    'Stack', 'Go, Rust']) {
    assert.ok(text.includes(fragment), `missing from the PDF: ${fragment}`);
  }
});

test('punctuation Typst would rewrite survives verbatim', async () => {
  // `--` used to become an en dash and `~` a non-breaking space, silently editing the candidate's own words.
  const { text } = await render(document({ title: 'NOTES', blocks: [{ kind: 'bullets',
    items: ['Migrated CI --- from Jenkins ~ two quarters', 'Range 10-20 and C++ / C#'] }] }));
  assert.ok(text.includes('CI --- from Jenkins ~ two quarters'), text);
  assert.ok(text.includes('10-20 and C++ / C#'), text);
});

test('markup in the content cannot reach the compiler as markup', async () => {
  const hostile = '#let x = 1 [bracket] $math$ *star* _under_ `code` @ref <label>';
  const { text } = await render(document({ title: 'NOTES', blocks: [{ kind: 'text', text: hostile }] }));
  assert.ok(text.includes('#let x = 1 [bracket] $math$'), text);
  assert.ok(text.includes('`code` @ref <label>'), text);
});

test('emphasis markers are consumed rather than printed', async () => {
  const { text } = await render(document({ title: 'NOTES',
    blocks: [{ kind: 'text', text: 'A **bold** and *italic* claim.' }] }));
  assert.equal(text.includes('*'), false, text);
  assert.ok(text.includes('A bold and italic claim.'), text);
});

test('long content grows the page rather than breaking across pages', async () => {
  const short = await render(document({ title: 'EXPERIENCE',
    blocks: [{ kind: 'entry', title: 'Acme Corp', meta: '2020-2024', bullets: filler(4) }] }));
  const long = await render(document({ title: 'EXPERIENCE',
    blocks: [{ kind: 'entry', title: 'Acme Corp', meta: '2020-2024', bullets: filler(130) }] }));
  assert.equal(short.pages, 1);
  assert.equal(long.pages, 1);
  assert.ok(long.height > short.height * 3, `expected the page to grow, got ${short.height} then ${long.height}`);
});

test('the type is not shrunk to fit, so a long CV reads at the same size as a short one', async () => {
  const short = await render(document({ title: 'EXPERIENCE',
    blocks: [{ kind: 'entry', title: 'Acme Corp', meta: '2020-2024', bullets: filler(4) }] }));
  const long = await render(document({ title: 'EXPERIENCE',
    blocks: [{ kind: 'entry', title: 'Acme Corp', meta: '2020-2024', bullets: filler(40) }] }));
  // Each bullet costs the same vertical space in both, which it would not if the long one had been compressed.
  const perBullet = (long.height - short.height) / 36;
  assert.ok(perBullet > 8 && perBullet < 30, `unexpected per-bullet height ${perBullet}`);
});
