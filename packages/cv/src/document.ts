import * as v from 'valibot';

/**
 * The structured CV the tailoring agent returns, and the only input the PDF layout accepts.
 *
 * The previous contract was a plain string that the layout re-parsed with per-line heuristics — a pipe meant a job
 * header, a high capital-letter ratio meant a section — so an acronym list became a heading and a job title lost its
 * emphasis whenever the model chose a different separator. Naming the structure removes the guessing: the model
 * states what each block is, and the template decides how it looks.
 */

/**
 * The counts the schema enforces, the repair clips to, and the tailoring prompt quotes. Kept in one place because
 * a limit the agent is never told about is a limit it discovers by having its whole answer rejected.
 */
export const cvDocumentLimits = { contacts: 8, sections: 14, blocksPerSection: 40, bullets: 30, facts: 20 } as const;

/** Emphasis inside a run of text. `**bold**` and `*italic*` are the only markup; everything else is literal. */
const inline = (max: number) => v.pipe(v.string(), v.trim(), v.maxLength(max));
const filled = (max: number) => v.pipe(inline(max), v.minLength(1));

/** A paragraph of prose: a summary, a role description, a note under an entry. */
const textBlockSchema = v.object({ kind: v.literal('text'), text: filled(2_000) });

/** An unordered list. One achievement, responsibility or project per item. */
const bulletsBlockSchema = v.object({
  kind: v.literal('bullets'),
  items: v.pipe(v.array(filled(600)), v.minLength(1), v.maxLength(cvDocumentLimits.bullets)),
});

/**
 * A dated record: an employer, a degree, a certification. `meta` carries the dates and location and is set to the
 * right of the title, which is why they must not be repeated inside `title` or `subtitle`.
 */
const entryBlockSchema = v.object({
  kind: v.literal('entry'),
  title: filled(200),
  subtitle: v.optional(inline(300)),
  meta: v.optional(inline(160)),
  text: v.optional(inline(1_500)),
  bullets: v.optional(v.pipe(v.array(filled(600)), v.maxLength(cvDocumentLimits.bullets))),
});

/** Label-and-value rows: skill groups, languages, tooling. Rendered as an aligned two-column grid. */
const factsBlockSchema = v.object({
  kind: v.literal('facts'),
  items: v.pipe(v.array(v.object({ term: filled(120), detail: filled(800) })), v.minLength(1),
    v.maxLength(cvDocumentLimits.facts)),
});

const blockSchema = v.variant('kind', [textBlockSchema, bulletsBlockSchema, entryBlockSchema, factsBlockSchema]);

const sectionSchema = v.object({
  title: filled(80),
  blocks: v.pipe(v.array(blockSchema), v.minLength(1), v.maxLength(cvDocumentLimits.blocksPerSection)),
});

/**
 * A contact is one row item. Models reliably reach for `{label, value}` here even when asked for strings, so the
 * object form is accepted and reduced rather than bounced back for a retry the model would only lose tokens on.
 */
const contactSchema = v.pipe(
  v.union([v.string(), v.looseObject({})]),
  v.transform((value) => {
    if (typeof value === 'string') return value.trim();
    const fields = value as Record<string, unknown>;
    const pick = (key: string): string | undefined =>
      typeof fields[key] === 'string' && fields[key].trim() ? fields[key].trim() : undefined;
    return pick('value') ?? pick('text') ?? pick('url') ?? pick('handle') ?? pick('label') ?? '';
  }),
  v.minLength(1), v.maxLength(160),
);

export const cvDocumentSchema = v.object({
  name: filled(120),
  headline: v.optional(inline(200)),
  contacts: v.pipe(v.array(contactSchema), v.maxLength(cvDocumentLimits.contacts)),
  sections: v.pipe(v.array(sectionSchema), v.minLength(1), v.maxLength(cvDocumentLimits.sections)),
});

export type CvDocument = v.InferOutput<typeof cvDocumentSchema>;
export type CvSection = CvDocument['sections'][number];
export type CvBlock = CvSection['blocks'][number];

const bulletPattern = /^[•·‣▪*\-–—]\s+/;
const datePattern = /(?:\d{4}|\b(?:present|current|now|настоящее время)\b)/i;
const separatorPattern = /\s+[|·•]\s+/;

/**
 * Salvages a CV that arrived as plain text instead of structured blocks, so a model that regresses to the old
 * contract still produces a laid-out PDF rather than an error. It recovers structure only — the template still owns
 * every typographic decision — and it is deliberately conservative: a line it cannot classify becomes a paragraph.
 */
export function parseCvText(source: string): CvDocument {
  const lines = source.replaceAll('\r', '').split('\n').map((line) => line.trim());
  const isHeading = (line: string): boolean => {
    const letters = line.match(/\p{L}/gu)?.length ?? 0;
    const upper = line.match(/\p{Lu}/gu)?.length ?? 0;
    // A comma or a trailing period means an enumeration or a sentence, not a section label; "SQL, ETL, API, AWS"
    // used to be promoted to a heading purely because every letter in it happens to be a capital.
    return letters >= 3 && upper / letters > 0.8 && line.length <= 60
      && line.split(/\s+/).length <= 6 && !line.includes(',') && !line.endsWith('.');
  };

  const filledLines = lines.filter(Boolean);
  if (filledLines.length < 5) throw new Error('Tailored CV text contains too little content.');

  const name = filledLines[0]!;
  // Only the few lines that can plausibly be a headline or a contact row are taken as the header. A CV scraped
  // without any section labels would otherwise donate its entire body to the contact row.
  const preamble: string[] = [];
  let index = lines.indexOf(name) + 1;
  for (; index < lines.length && preamble.length < 4; index += 1) {
    const line = lines[index]!;
    if (!line) continue;
    if (isHeading(line) || line.length > 120 || line.endsWith('.') || bulletPattern.test(line)) break;
    preamble.push(line);
  }
  const headline = preamble.length > 1 || (preamble[0] && !separatorPattern.test(preamble[0])) ? preamble.shift() : undefined;
  const contacts = preamble.flatMap((line) => line.split(separatorPattern))
    .map((part) => part.trim()).filter(Boolean).slice(0, 8);

  const sections: CvSection[] = [];
  let section: CvSection | undefined;
  const push = (block: CvBlock): void => { if (section) section.blocks.push(block); };
  const bulletsFor = (): string[] => {
    const last = section?.blocks.at(-1);
    if (last?.kind === 'entry') return last.bullets ??= [];
    if (last?.kind === 'bullets') return last.items;
    const created: CvBlock = { kind: 'bullets', items: [] };
    push(created);
    return (created as Extract<CvBlock, { kind: 'bullets' }>).items;
  };

  for (; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line) continue;
    // A hard-wrapped paragraph arrives as several adjacent lines; only a blank line starts a new one. Without this
    // a CV scraped without any structure turns into hundreds of one-line blocks.
    const continues = index > 0 && lines[index - 1] !== '';
    if (isHeading(line)) { section = { title: line, blocks: [] }; sections.push(section); continue; }
    if (!section) { section = { title: 'Profile', blocks: [] }; sections.push(section); }
    if (bulletPattern.test(line)) { bulletsFor().push(line.replace(bulletPattern, '')); continue; }

    // A line introducing bullets is the header of a dated record; the trailing date range becomes its meta column.
    const next = lines.slice(index + 1).find(Boolean);
    const separator = line.match(/\s+[—–]\s+|\s+\|\s+/);
    const [head, tail] = separator
      ? [line.slice(0, separator.index), line.slice(separator.index! + separator[0]!.length)] : [line, undefined];
    if (next && bulletPattern.test(next) && line.length < 200) {
      push(tail && datePattern.test(tail)
        ? { kind: 'entry', title: head!, meta: tail }
        : { kind: 'entry', title: head!, ...tail ? { subtitle: tail } : {} });
      continue;
    }
    // A label/value row, not any sentence that happens to contain a colon: a long or many-worded left side is prose,
    // and treating it as a term produced a bold half-sentence beside a stranded remainder.
    const facts = line.match(/^([^:]{2,32}):\s+(.+)$/);
    if (facts && facts[1]!.split(/\s+/).length <= 3) {
      const last = section.blocks.at(-1);
      if (last?.kind === 'facts') last.items.push({ term: facts[1]!, detail: facts[2]! });
      else push({ kind: 'facts', items: [{ term: facts[1]!, detail: facts[2]! }] });
      continue;
    }
    const last = section.blocks.at(-1);
    if (continues && last?.kind === 'text') last.text = `${last.text} ${line}`;
    else push({ kind: 'text', text: line });
  }

  return v.parse(cvDocumentSchema, { name, headline, contacts, sections: sections.filter((item) => item.blocks.length) });
}

const record = (value: unknown): Record<string, unknown> | null =>
  value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string | undefined => {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number') return String(value);
  return undefined;
};
const list = (value: unknown): string[] =>
  (Array.isArray(value) ? value : value == null ? [] : [value]).map(text).filter((item): item is string => item != null);
const contactList = (value: unknown): unknown[] => Array.isArray(value) ? value : value == null ? [] : [value];

/**
 * Coerces the shapes the model reaches for when it drifts off the contract: `type` for `kind`, a bare string where a
 * list belongs, an entry flattened into `company`/`role`/`period`. Anything still unrecognisable is dropped rather
 * than rendered as debris, and a document left without sections fails validation instead of producing an empty PDF.
 */
export function normalizeCvDocumentJson(value: unknown): unknown {
  const root = record(value);
  if (!root) return value;
  const source = record(root.cv) ?? record(root.document) ?? root;

  const blockOf = (raw: unknown): unknown => {
    if (typeof raw === 'string') return { kind: 'text', text: raw };
    const block = record(raw);
    if (!block) return null;
    const kind = text(block.kind) ?? text(block.type);
    const items = list(block.items ?? block.bullets ?? block.points ?? block.list);
    const title = text(block.title) ?? text(block.company) ?? text(block.employer) ?? text(block.organization)
      ?? text(block.institution) ?? text(block.name);
    const facts = Array.isArray(block.items)
      ? block.items.map(record).filter((item): item is Record<string, unknown> => item != null)
        .map((item) => ({ term: text(item.term) ?? text(item.label) ?? text(item.name) ?? '',
          detail: text(item.detail) ?? text(item.value) ?? list(item.items).join(', ') }))
        .filter((item) => item.term && item.detail)
      : [];
    if (kind === 'facts' || (!kind && facts.length > 0)) {
      return facts.length ? { kind: 'facts', items: facts.slice(0, cvDocumentLimits.facts) } : null;
    }
    if (title) {
      const subtitle = text(block.subtitle) ?? text(block.role) ?? text(block.position) ?? text(block.degree);
      const meta = text(block.meta) ?? text(block.period) ?? text(block.dates) ?? text(block.date)
        ?? text(block.location);
      const summary = text(block.text) ?? text(block.summary) ?? text(block.description);
      // Absent fields are omitted rather than set to undefined, so a coerced entry is indistinguishable from one the
      // model got right the first time.
      return { kind: 'entry', title, ...subtitle ? { subtitle } : {}, ...meta ? { meta } : {},
        ...summary ? { text: summary } : {},
        ...items.length ? { bullets: items.slice(0, cvDocumentLimits.bullets) } : {} };
    }
    if (items.length) return { kind: 'bullets', items: items.slice(0, cvDocumentLimits.bullets) };
    const body = text(block.text) ?? text(block.summary) ?? text(block.description) ?? text(block.content);
    return body ? { kind: 'text', text: body } : null;
  };

  // Clipping to the schema's own counts turns a rejected answer into a slightly shorter CV, which is the better
  // outcome for a deliverable the user is waiting on. It only ever runs after the model has failed to comply.
  const sections = (Array.isArray(source.sections) ? source.sections : []).map(record)
    .filter((section): section is Record<string, unknown> => section != null)
    .map((section) => ({
      title: text(section.title) ?? text(section.heading) ?? text(section.name) ?? '',
      blocks: (Array.isArray(section.blocks) ? section.blocks : [section.blocks ?? section.content ?? section.items])
        .map(blockOf).filter((block) => block != null).slice(0, cvDocumentLimits.blocksPerSection),
    }))
    .filter((section) => section.title && section.blocks.length > 0)
    .slice(0, cvDocumentLimits.sections);

  return {
    ...root,
    cv: {
      name: text(source.name) ?? text(source.fullName) ?? '',
      headline: text(source.headline) ?? text(source.title) ?? text(source.role),
      contacts: contactList(source.contacts ?? source.contact).slice(0, cvDocumentLimits.contacts),
      sections,
    },
  };
}
