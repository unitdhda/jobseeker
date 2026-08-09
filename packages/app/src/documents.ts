import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCvPdf, type CvDocument } from '@jobseeker/cv/pdf';

/** The application package always renders with its bundled OFL font set. */
const packagedFonts = join(dirname(fileURLToPath(import.meta.url)), '..', 'fonts');
const renderer = createCvPdf({ fontPaths: [packagedFonts] });

export const compileTypst = (source: string): Buffer => renderer.compileTypst(source);
export const compileCvDocument = (document: CvDocument): Buffer => renderer.compileCvDocument(document);
export const compilePlainTextCv = (text: string): Buffer => renderer.compilePlainTextCv(text);

/**
 * Exactly one side is populated: a request asks for the tailored CV or for the cover letter, never both.
 *
 * A generated artifact is never held anywhere: it is produced in the job worker and returned across the IPC
 * boundary to the caller that sends it, so the PDF exists only for the length of that one request.
 */
export interface GeneratedApplication {
  tailoredCvPdf: Buffer | null;
  coverLetter: string | null;
}
