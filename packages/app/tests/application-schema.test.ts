import assert from 'node:assert/strict';
import test from 'node:test';
import * as v from 'valibot';
import { coverLetterResultSchema, cvResultSchema } from '../src/workflows.ts';

const coverLetter='Concrete overlap with the vacancy and an evidence-based application. '.repeat(2);
const tailoredCvText='Tailored CV evidence. '.repeat(30);
const cv={name:'Ivan Petrov',headline:'Backend Engineer',contacts:['Remote','first.last@example.com'],
  sections:[{title:'SUMMARY',blocks:[{kind:'text' as const,text:'Eight years of backend work.'}]}]};

test('cv output accepts a structured cv document',()=>{
  const result=v.parse(cvResultSchema,{cv});
  assert.deepEqual(result.cv,cv);
  assert.equal(result.tailoredCvText,null);
});

test('cv output still accepts a plain-text cv so a regressed model is not a hard failure',()=>{
  const result=v.parse(cvResultSchema,{tailoredCvText});
  assert.equal(result.tailoredCvText,tailoredCvText);
  assert.equal(result.cv,null);
});

test('contacts given as label/value objects are reduced to the value',()=>{
  const result=v.parse(cvResultSchema,{cv:{...cv,
    contacts:[{label:'Email',value:'first.last@example.com'},{label:'Telegram',handle:'@username'}]}});
  assert.deepEqual(result.cv?.contacts,['first.last@example.com','@username']);
});

test('a response carrying neither a cv nor cv text is rejected',()=>{
  assert.equal(v.safeParse(cvResultSchema,{}).success,false);
  assert.equal(v.safeParse(cvResultSchema,{coverLetter}).success,false);
});

test('the two deliverables are independent contracts',()=>{
  // A CV request no longer has to carry a letter, and a letter request no longer has to carry a CV.
  assert.equal(v.safeParse(cvResultSchema,{cv}).success,true);
  assert.equal(v.safeParse(coverLetterResultSchema,{coverLetter}).success,true);
  assert.equal(v.safeParse(coverLetterResultSchema,{cv}).success,false);
});

test('the letter contract normalizes the model coverLetterText alias',()=>{
  assert.equal(v.parse(coverLetterResultSchema,{coverLetterText:coverLetter}).coverLetter,coverLetter);
  assert.equal(v.safeParse(coverLetterResultSchema,{coverLetter:'too short'}).success,false);
});

test('a cover letter that ignores the length instruction is rejected rather than sent',()=>{
  const overlong='Evidence-based paragraph about the concrete overlap with this vacancy. '.repeat(40);
  assert.ok(overlong.length>2_000);
  assert.equal(v.safeParse(coverLetterResultSchema,{coverLetter:overlong}).success,false);
});
