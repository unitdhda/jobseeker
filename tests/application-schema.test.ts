import assert from 'node:assert/strict';
import test from 'node:test';
import * as v from 'valibot';
import { applicationResultSchema } from '../src/workflows.ts';

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
