# @jobseeker/cv

Everything about the CV as a document, in two deliberately separate subpaths — there is no root barrel, because
the two halves have different dependency weights and consumers:

- **`@jobseeker/cv/extract`** — turns an uploaded PDF/DOCX/Markdown into authoritative text plus a normalized
  document structure; detects the CV language. Heavy parsing dependencies live only here.
- **`@jobseeker/cv/pdf`** — renders a structured CV (the `cvDocumentSchema` block vocabulary: headline, roles
  with meta, skill groups, sections) into a paginated A4 PDF through Typst. Fixed pagination with a density
  ladder rather than variable page height; single column; no letter-spacing tricks, so ATS text extraction reads
  what the human reads. `parseCvText` salvages prose CVs from a model that regressed to plain text.

Fonts are a factory option (`createCvPdf({fontPaths})`), never an environment read. The app supplies
`TYPST_FONT_PATHS` at composition.

```bash
bun test packages/cv
```
