export {
  cvDocumentLimits, cvDocumentSchema, normalizeCvDocumentJson, parseCvText,
  type CvBlock, type CvDocument, type CvSection,
} from './document.ts';
export { cvPreamble } from './template.ts';
export { assertTailoredCvEvidence, tailoredCvEvidenceIssues, type CvEvidenceIssue } from './evidence.ts';
export { createCvPdf, cvSource, type CvPdf, type CvPdfOptions } from './render.ts';
