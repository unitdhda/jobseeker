import * as v from 'valibot';

export const cvDocumentLimits = {
  contacts: 8,
  sections: 14,
  blocksPerSection: 40,
  bullets: 30,
  facts: 20,
} as const;

const nonemptyText = v.pipe(v.string(), v.trim(), v.minLength(1));
const boundedText = (maximum: number) => v.pipe(nonemptyText, v.maxLength(maximum));

const textBlockSchema = v.strictObject({
  kind: v.literal('text'),
  text: nonemptyText,
});
const bulletsBlockSchema = v.strictObject({
  kind: v.literal('bullets'),
  items: v.pipe(v.array(nonemptyText), v.minLength(1), v.maxLength(cvDocumentLimits.bullets)),
});
const entryBlockSchema = v.strictObject({
  kind: v.literal('entry'),
  title: nonemptyText,
  subtitle: v.optional(nonemptyText),
  meta: v.optional(nonemptyText),
  text: v.optional(nonemptyText),
  bullets: v.optional(v.pipe(v.array(nonemptyText), v.minLength(1), v.maxLength(cvDocumentLimits.bullets))),
});
const factSchema = v.strictObject({ term: nonemptyText, detail: nonemptyText });
const factsBlockSchema = v.strictObject({
  kind: v.literal('facts'),
  items: v.pipe(v.array(factSchema), v.minLength(1), v.maxLength(cvDocumentLimits.facts)),
});

export const cvBlockSchema = v.variant('kind', [
  textBlockSchema,
  bulletsBlockSchema,
  entryBlockSchema,
  factsBlockSchema,
]);

export const cvSectionSchema = v.strictObject({
  title: boundedText(80),
  blocks: v.pipe(v.array(cvBlockSchema), v.minLength(1), v.maxLength(cvDocumentLimits.blocksPerSection)),
});

export const cvDocumentSchema = v.strictObject({
  name: boundedText(120),
  headline: v.optional(boundedText(200)),
  contacts: v.pipe(v.array(boundedText(160)), v.maxLength(cvDocumentLimits.contacts)),
  sections: v.pipe(v.array(cvSectionSchema), v.maxLength(cvDocumentLimits.sections)),
});

export type CvDocument = v.InferOutput<typeof cvDocumentSchema>;
export type CvSection = CvDocument['sections'][number];
export type CvBlock = CvSection['blocks'][number];

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.normalize('NFC').replace(/\s+/gu, ' ').trim();
  return cleaned || undefined;
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = cleanString(record[key]);
    if (value) return value;
  }
  return undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => cleanString(item)).filter((item): item is string => item !== undefined);
}

function normalizeContact(value: unknown): string | undefined {
  const direct = cleanString(value);
  if (direct) return direct;
  const record = recordOf(value);
  return record ? firstString(record, ['value', 'text', 'url', 'handle', 'label']) : undefined;
}

function normalizeFact(value: unknown): { term: string; detail: string } | null {
  const record = recordOf(value);
  if (!record) return null;
  const term = firstString(record, ['term', 'label', 'name', 'key']);
  const detail = firstString(record, ['detail', 'value', 'text', 'description']);
  return term && detail ? { term, detail } : null;
}

function normalizeFacts(value: unknown): Array<{ term: string; detail: string }> {
  if (Array.isArray(value)) return value.map(normalizeFact).filter((fact): fact is NonNullable<typeof fact> => fact !== null);
  const record = recordOf(value);
  if (!record) return [];
  return Object.entries(record).flatMap(([term, detail]) => {
    const text = cleanString(detail);
    return text ? [{ term: term.trim(), detail: text }] : [];
  });
}

function normalizeBlock(value: unknown): Record<string, unknown> | null {
  const text = cleanString(value);
  if (text) return { kind: 'text', text };
  const record = recordOf(value);
  if (!record) return null;

  const kind = cleanString(record.kind) ?? cleanString(record.type);
  if (kind === 'text' || kind === 'paragraph') {
    const blockText = firstString(record, ['text', 'value', 'content', 'description']);
    return blockText ? { kind: 'text', text: blockText } : null;
  }
  if (kind === 'bullets' || kind === 'list' || kind === 'bullet-list') {
    const items = stringArray(record.items ?? record.points ?? record.bullets).slice(0, cvDocumentLimits.bullets);
    return items.length ? { kind: 'bullets', items } : null;
  }
  if (kind === 'facts' || kind === 'fact-list') {
    const items = normalizeFacts(record.items ?? record.facts).slice(0, cvDocumentLimits.facts);
    return items.length ? { kind: 'facts', items } : null;
  }

  const title = firstString(record, [
    'title', 'company', 'employer', 'organization', 'institution', 'name',
  ]);
  const looksLikeEntry = kind === 'entry' || title !== undefined;
  if (!looksLikeEntry || !title) return null;

  const subtitle = firstString(record, ['subtitle', 'role', 'position', 'degree']);
  const meta = firstString(record, ['meta', 'period', 'dates', 'date', 'location']);
  const entryText = firstString(record, ['text', 'summary', 'description']);
  const bullets = stringArray(record.bullets ?? record.points).slice(0, cvDocumentLimits.bullets);
  const entry: Record<string, unknown> = { kind: 'entry', title };
  if (subtitle) entry.subtitle = subtitle;
  if (meta) entry.meta = meta;
  if (entryText) entry.text = entryText;
  if (bullets.length) entry.bullets = bullets;
  return entry;
}

function normalizeSection(value: unknown): Record<string, unknown> | null {
  const record = recordOf(value);
  if (!record) return null;
  const title = firstString(record, ['title', 'name', 'heading']);
  if (!title) return null;
  const rawBlocks = Array.isArray(record.blocks)
    ? record.blocks
    : Array.isArray(record.items) ? record.items : [];
  const blocks = rawBlocks.map(normalizeBlock)
    .filter((block): block is Record<string, unknown> => block !== null)
    .slice(0, cvDocumentLimits.blocksPerSection);
  return blocks.length ? { title, blocks } : null;
}

/** Repairs common model-output drift without inventing document facts or retaining unrecognizable debris. */
export function normalizeCvDocumentJson(value: unknown): unknown {
  let root = recordOf(value);
  while (root) {
    const envelope = recordOf(root.cv) ?? recordOf(root.document);
    if (!envelope) break;
    root = envelope;
  }
  if (!root) return value;

  const name = firstString(root, ['name', 'fullName', 'full_name']);
  if (!name) return value;
  const result: Record<string, unknown> = { name };
  const headline = firstString(root, ['headline', 'title', 'position', 'role']);
  if (headline) result.headline = headline;

  const contacts = (Array.isArray(root.contacts) ? root.contacts : root.contacts === undefined ? [] : [root.contacts])
    .map(normalizeContact)
    .filter((contact): contact is string => contact !== undefined)
    .slice(0, cvDocumentLimits.contacts);
  result.contacts = contacts;

  const rawSections = Array.isArray(root.sections) ? root.sections : [];
  result.sections = rawSections.map(normalizeSection)
    .filter((section): section is Record<string, unknown> => section !== null)
    .slice(0, cvDocumentLimits.sections);
  return result;
}

const bulletPattern = /^\s*(?:[-*•‣▪◦]|\d+[.)])\s+(.+)$/u;
const dateTailPattern = /^(.*?)\s+(\(?\b(?:19|20)\d{2}(?:\s*[–—-]\s*(?:(?:19|20)\d{2}|present|current|now|н\.?в\.?|настоящее время))?\b[^)]*\)?)$/iu;
const factPattern = /^([^:]{2,40}):\s+(.+)$/u;
const commonHeadings = new Set([
  'experience', 'work experience', 'employment', 'education', 'skills', 'projects', 'summary', 'profile',
  'опыт', 'опыт работы', 'образование', 'навыки', 'проекты', 'о себе', 'профиль',
]);

function isHeading(line: string): boolean {
  const cleaned = line.trim().replace(/:$/u, '');
  if (commonHeadings.has(cleaned.toLowerCase())) return true;
  if (cleaned.length < 3 || cleaned.length > 80 || /[.!?]$/u.test(cleaned)) return false;
  const words = cleaned.match(/[\p{L}\p{N}+#.]+/gu) ?? [];
  if (words.length === 0 || words.length > 8) return false;
  const uppercase = cleaned === cleaned.toUpperCase() && cleaned !== cleaned.toLowerCase();
  // Acronym inventories such as "SQL AWS API" are evidence, not section structure.
  return uppercase && words.some((word) => Array.from(word).length > 3);
}

function isHeaderCandidate(line: string): boolean {
  if (line.length > 120 || bulletPattern.test(line) || factPattern.test(line) || isHeading(line)) return false;
  const words = line.match(/\p{L}+/gu) ?? [];
  return words.length >= 2 && words.length <= 8 && !/[.!?]$/u.test(line);
}

function isStructuralLine(line: string): boolean {
  return !line || isHeading(line) || bulletPattern.test(line) || factPattern.test(line) || dateTailPattern.test(line);
}

function appendBullet(blocks: Record<string, unknown>[], item: string): void {
  const previous = blocks.at(-1);
  if (previous?.kind === 'entry') {
    const bullets = Array.isArray(previous.bullets) ? previous.bullets as string[] : [];
    if (bullets.length < cvDocumentLimits.bullets) previous.bullets = [...bullets, item];
    return;
  }
  if (previous?.kind === 'bullets') {
    const items = previous.items as string[];
    if (items.length < cvDocumentLimits.bullets) previous.items = [...items, item];
    return;
  }
  blocks.push({ kind: 'bullets', items: [item] });
}

/** Conservatively salvages prose into a small structured CV without treating the body as contact data. */
export function parseCvText(source: string): CvDocument {
  const normalized = source.normalize('NFC').replace(/\r\n?/gu, '\n').replace(/\u00a0/gu, ' ');
  if (normalized.replace(/\s/gu, '').length < 100) {
    throw new RangeError('Invalid CV text: expected at least 100 non-whitespace characters.');
  }
  const lines = normalized.split('\n').map((line) => line.trim());
  let first = lines.findIndex(Boolean);
  const name = first >= 0 && isHeaderCandidate(lines[first]!) ? lines[first++]! : 'Curriculum Vitae';
  while (first < lines.length && !lines[first]) first += 1;
  let headline: string | undefined;
  if (first < lines.length && isHeaderCandidate(lines[first]!) && !isStructuralLine(lines[first]!)) {
    headline = lines[first++]!;
  }

  const sections: Array<{ title: string; blocks: Record<string, unknown>[] }> = [];
  let current = { title: 'Profile', blocks: [] as Record<string, unknown>[] };
  const flush = (): void => {
    if (current.blocks.length) sections.push({
      title: current.title,
      blocks: current.blocks.slice(0, cvDocumentLimits.blocksPerSection),
    });
  };

  for (let index = first; index < lines.length;) {
    const line = lines[index]!;
    if (!line) { index += 1; continue; }
    if (isHeading(line)) {
      flush();
      current = { title: line.replace(/:$/u, ''), blocks: [] };
      index += 1;
      continue;
    }
    const bullet = bulletPattern.exec(line);
    if (bullet) {
      appendBullet(current.blocks, bullet[1]!.trim());
      index += 1;
      continue;
    }
    const fact = factPattern.exec(line);
    if (fact) {
      const facts: Array<{ term: string; detail: string }> = [];
      while (index < lines.length && facts.length < cvDocumentLimits.facts) {
        const match = factPattern.exec(lines[index]!);
        if (!match) break;
        facts.push({ term: match[1]!.trim(), detail: match[2]!.trim() });
        index += 1;
      }
      current.blocks.push({ kind: 'facts', items: facts });
      continue;
    }
    const dated = dateTailPattern.exec(line);
    if (dated && dated[1]!.trim()) {
      current.blocks.push({ kind: 'entry', title: dated[1]!.trim(), meta: dated[2]!.trim() });
      index += 1;
      continue;
    }

    const paragraph = [line];
    index += 1;
    while (index < lines.length && !isStructuralLine(lines[index]!)) {
      paragraph.push(lines[index]!);
      index += 1;
    }
    current.blocks.push({ kind: 'text', text: paragraph.join(' ') });
  }
  flush();

  return v.parse(cvDocumentSchema, {
    name,
    ...(headline ? { headline } : {}),
    contacts: [],
    sections: sections.slice(0, cvDocumentLimits.sections),
  });
}
