# `@jobseeker/cv`

Deterministic CV extraction, evidence validation, and Typst PDF rendering. The package does not know users, models, persistence, or environment variables.

## Extraction

```ts
import { extractCvDocument } from '@jobseeker/cv/extract';

const extracted = await extractCvDocument(
  'cv.pdf',
  'application/pdf',
  uploadedBytes,
);
```

Extraction accepts bytes rather than file paths, validates extension/media/magic agreement, preflights DOCX ZIP safety, and returns normalized text plus annotated canonical blocks.

## Structured PDF rendering

```ts
import {
  assertTailoredCvEvidence,
  createCvPdf,
  parseCvText,
} from '@jobseeker/cv/pdf';

const document = parseCvText(authoritativeText);
assertTailoredCvEvidence(document, authoritativeText);

const pdf = createCvPdf({
  fontPaths: ['/deployment/fonts'],
}).compileCvDocument(document);
```

Rendering accepts only structured document content and emits calls into a fixed Typst component library. Font paths are injected explicitly; this package never reads environment variables.
