import assert from 'node:assert/strict';
import test from 'node:test';
import * as v from 'valibot';
import { applicationResultSchema, coverLetterResultSchema } from '../src/workflows.ts';

const coverLetter='Concrete overlap with the vacancy and an evidence-based application. '.repeat(2);
const tailoredCvText='Tailored CV evidence. '.repeat(30);
const cv={name:'Ivan Petrov',headline:'Backend Engineer',contacts:['Remote','first.last@example.com'],
  sections:[{title:'SUMMARY',blocks:[{kind:'text' as const,text:'Eight years of backend work.'}]}]};

test('application output accepts a structured cv document',()=>{
  const result=v.parse(applicationResultSchema,{cv,coverLetter});
  assert.deepEqual(result.cv,cv);
  assert.equal(result.tailoredCvText,null);
  assert.equal(result.coverLetter,coverLetter);
});

test('application output normalizes the model coverLetterText alias',()=>{
  const result=v.parse(applicationResultSchema,{cv,coverLetterText:coverLetter});
  assert.equal(result.coverLetter,coverLetter);
});

test('application output still accepts a plain-text cv so a regressed model is not a hard failure',()=>{
  const result=v.parse(applicationResultSchema,{tailoredCvText,coverLetter});
  assert.equal(result.tailoredCvText,tailoredCvText);
  assert.equal(result.cv,null);
});

test('contacts given as label/value objects are reduced to the value',()=>{
  const result=v.parse(applicationResultSchema,{cv:{...cv,
    contacts:[{label:'Email',value:'first.last@example.com'},{label:'Telegram',handle:'@username'}]},coverLetter});
  assert.deepEqual(result.cv?.contacts,['first.last@example.com','@username']);
});

test('a response carrying neither a cv nor cv text is rejected',()=>{
  assert.equal(v.safeParse(applicationResultSchema,{coverLetter}).success,false);
});

test('a cv without a cover letter is rejected',()=>{
  assert.equal(v.safeParse(applicationResultSchema,{cv}).success,false);
});

test('past the document quota the letter alone is a complete result', () => {
  // The CV contract still refuses a letter on its own; the letter-only contract is what the quota falls back to.
  assert.equal(v.safeParse(applicationResultSchema, { coverLetter }).success, false);
  const result = v.parse(coverLetterResultSchema, { coverLetter });
  assert.equal(result.coverLetter, coverLetter);
  assert.equal(v.parse(coverLetterResultSchema, { coverLetterText: coverLetter }).coverLetter, coverLetter);
  assert.equal(v.safeParse(coverLetterResultSchema, { coverLetter: 'too short' }).success, false);
});

test('a cover letter that ignores the length instruction is rejected rather than sent', () => {
  const overlong = 'Evidence-based paragraph about the concrete overlap with this vacancy. '.repeat(40);
  assert.ok(overlong.length > 2_000);
  assert.equal(v.safeParse(coverLetterResultSchema, { coverLetter: overlong }).success, false);
  assert.equal(v.safeParse(applicationResultSchema, { cv, coverLetter: overlong }).success, false);
});
