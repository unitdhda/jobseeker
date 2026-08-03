import assert from 'node:assert/strict';
import test from 'node:test';
import * as v from 'valibot';
import { applicationResultSchema } from '../src/workflows.ts';

const tailoredCvText='Tailored CV evidence. '.repeat(30);
const coverLetter='Concrete overlap with the vacancy and an evidence-based application. '.repeat(2);

test('application output accepts the canonical cover-letter field',()=>{
  const result=v.parse(applicationResultSchema,{tailoredCvText,coverLetter});
  assert.deepEqual(result,{tailoredCvText,coverLetter});
});

test('application output normalizes the model coverLetterText alias',()=>{
  const result=v.parse(applicationResultSchema,{tailoredCvText,coverLetterText:coverLetter});
  assert.deepEqual(result,{tailoredCvText,coverLetter});
});
