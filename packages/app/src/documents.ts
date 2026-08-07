import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCvPdf, type CvDocument } from '@jobseeker/cv/pdf';

/** The composition point: fonts come from the environment here — defaulting to the OFL set the package ships. */
const packagedFonts = join(dirname(fileURLToPath(import.meta.url)), '..', 'fonts');
const renderer = createCvPdf({
  fontPaths: (process.env.TYPST_FONT_PATHS ?? packagedFonts).split(delimiter).filter(Boolean),
});

export const compileTypst = (source: string): Buffer => renderer.compileTypst(source);
export const compileCvDocument = (document: CvDocument): Buffer => renderer.compileCvDocument(document);
export const compilePlainTextCv = (text: string): Buffer => renderer.compilePlainTextCv(text);

/** Exactly one side is populated: a request asks for the tailored CV or for the cover letter, never both. */
export interface GeneratedApplication {
  tailoredCvPdf: Buffer | null;
  coverLetter: string | null;
}

const staged = new Map<string, GeneratedApplication>();
const key = (userId: string, vacancyId: number): string => `${userId}:${vacancyId}`;

export function stageApplicationArtifacts(userId: string, vacancyId: number, artifacts: GeneratedApplication): void {
  staged.set(key(userId, vacancyId), artifacts);
}

export function getApplicationArtifacts(userId: string, vacancyId: number): GeneratedApplication | null {
  return staged.get(key(userId, vacancyId)) ?? null;
}

export function clearApplicationArtifacts(userId: string, vacancyId: number): void {
  staged.delete(key(userId, vacancyId));
}
