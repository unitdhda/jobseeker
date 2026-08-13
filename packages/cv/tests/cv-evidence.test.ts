import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertTailoredCvEvidence,
  CvEvidenceError,
  tailoredCvEvidenceIssues,
} from '../src/evidence.ts';
import type { CvDocument } from '../src/document.ts';

const authoritative = `Ada Lovelace
ada@example.test
Analytical Engines
Software Engineer, 2020–2024
Improved throughput by 25% while using JavaScript, TypeScript, PostgreSQL, Kubernetes,
retrieval augmented generation, large language models, and generative AI.
`;

function documentWith(blocks: CvDocument['sections'][number]['blocks'], contacts = ['ada@example.test']): CvDocument {
  return { name: 'Ada Lovelace', contacts, sections: [{ title: 'Experience', blocks }] };
}

test('authoritative entries, contacts, numeric claims, and explicit aliases are accepted', () => {
  const document = documentWith([
    { kind: 'entry', title: 'Analytical Engines', subtitle: 'Software Engineer', meta: '2020–2024', bullets: ['Improved throughput by 25%'] },
    { kind: 'facts', items: [{ term: 'Skills', detail: 'JS, TS, Postgres, K8s, RAG, LLM, GenAI' }] },
  ]);
  assert.deepEqual(tailoredCvEvidenceIssues(document, authoritative), []);
  assert.doesNotThrow(() => assertTailoredCvEvidence(document, authoritative));
});

test('invented numbers, entries, contacts, and named skills are rejected deterministically', () => {
  const document = documentWith([
    { kind: 'entry', title: 'Imaginary Corporation', bullets: ['Improved throughput by 40%'] },
    { kind: 'facts', items: [{ term: 'Skills', detail: 'TypeScript, Rust' }] },
  ], ['invented@example.test']);
  assert.deepEqual(tailoredCvEvidenceIssues(document, authoritative), [
    { kind: 'new-number', value: '40%' },
    { kind: 'unknown-contact', value: 'invented@example.test' },
    { kind: 'unknown-entry', value: 'Imaginary Corporation' },
    { kind: 'unsupported-skill', value: 'Rust' },
  ]);
});

test('token boundaries prevent short aliases from matching unrelated words', () => {
  const document = documentWith([
    { kind: 'facts', items: [{ term: 'Skills', detail: 'Go' }] },
  ], []);
  const issues = tailoredCvEvidenceIssues(document, 'Built products at Google.');
  assert.deepEqual(issues, [{ kind: 'unsupported-skill', value: 'Go' }]);
});

test('assertion exposes issues and bounds the error summary', () => {
  const document = documentWith([
    { kind: 'facts', items: [{ term: 'Skills', detail: Array.from({ length: 12 }, (_, index) => `Invented${index}`).join(', ') }] },
  ], []);
  assert.throws(() => assertTailoredCvEvidence(document, authoritative), (error) => {
    assert.ok(error instanceof CvEvidenceError);
    assert.equal(error.issues.length, 12);
    assert.match(error.message, /and 4 more/);
    assert.doesNotMatch(error.message, /Improved throughput/);
    return true;
  });
});
