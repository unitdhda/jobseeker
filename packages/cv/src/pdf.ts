export type { CvBlock, CvDocument, CvSection } from './document.ts';
export {
  cvBlockSchema,
  cvDocumentLimits,
  cvDocumentSchema,
  cvSectionSchema,
  normalizeCvDocumentJson,
  parseCvText,
} from './document.ts';
export type { CvEvidenceIssue } from './evidence.ts';
export {
  assertTailoredCvEvidence,
  CvEvidenceError,
  tailoredCvEvidenceIssues,
} from './evidence.ts';
export { cvPreamble } from './template.ts';
export type { CvPdf, CvPdfOptions } from './render.ts';
export { createCvPdf, cvSource } from './render.ts';
