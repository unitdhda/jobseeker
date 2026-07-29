import {
  definePDFJSModule,
  extractText as extractTextBase,
  getDocumentProxy as getDocumentProxyBase,
} from 'unpdf';

let configured: Promise<void> | undefined;
function configurePdf(): Promise<void> {
  return configured ??= definePDFJSModule(() => import('pdfjs-dist/legacy/build/pdf.mjs'));
}

export async function getDocumentProxy(...args: Parameters<typeof getDocumentProxyBase>) {
  await configurePdf();
  return getDocumentProxyBase(...args);
}

export async function extractText(...args: Parameters<typeof extractTextBase>) {
  await configurePdf();
  return extractTextBase(...args);
}
