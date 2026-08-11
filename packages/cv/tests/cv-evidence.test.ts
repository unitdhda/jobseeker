import assert from 'node:assert/strict';
import test from 'node:test';
import { assertTailoredCvEvidence, tailoredCvEvidenceIssues, type CvDocument } from '../src/pdf.ts';

const source=`Jane Example\njane@example.com | Berlin\nAcme Corp\nPlatform Engineer | 2021-2024\nReduced latency by 35% for 12 services.\nSkills: TypeScript, PostgreSQL, Kubernetes, retrieval augmented generation`;
const cv: CvDocument={name:'Jane Example',headline:'Senior Platform Engineer',contacts:['jane@example.com','Berlin'],sections:[
  {title:'EXPERIENCE',blocks:[{kind:'entry',title:'Acme Corp',subtitle:'Platform Engineer',meta:'2021-2024',
    bullets:['Reduced latency by 35% for 12 services.']}]},
  {title:'SKILLS',blocks:[{kind:'facts',items:[{term:'Platform',detail:'TypeScript, Postgres, K8s, RAG'}]}]},
]};

test('tailored CV evidence accepts source identities, metrics, contacts, and skill aliases',()=>{
  assert.deepEqual(tailoredCvEvidenceIssues(cv,source),[]);
  assert.doesNotThrow(()=>assertTailoredCvEvidence(cv,source));
});

test('tailored CV evidence rejects invented facts before rendering',()=>{
  const changed: CvDocument={...cv,contacts:['invented@example.com'],sections:[
    {title:'EXPERIENCE',blocks:[{kind:'entry',title:'Other Corp',meta:'2021-2025',bullets:['Improved revenue by 80%.']}]},
    {title:'SKILLS',blocks:[{kind:'facts',items:[{term:'Platform',detail:'TypeScript, Rust'}]}]},
  ]};
  const issues=tailoredCvEvidenceIssues(changed,source);
  assert.deepEqual(new Set(issues.map((issue)=>issue.kind)),new Set([
    'new-number','unknown-entry','unknown-contact','unsupported-skill',
  ]));
  assert.throws(()=>assertTailoredCvEvidence(changed,source),/unsupported evidence/);
});
