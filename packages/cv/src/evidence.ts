import type { CvBlock, CvDocument } from './document.ts';

export interface CvEvidenceIssue {
  readonly kind: 'new-number' | 'unknown-entry' | 'unknown-contact' | 'unsupported-skill';
  readonly value: string;
}

const skillTerms = new Set([
  'skill', 'skills', 'technology', 'technologies', 'tool', 'tools', 'language', 'languages',
  'навык', 'навыки', 'технология', 'технологии', 'инструмент', 'инструменты', 'язык', 'языки',
]);

const aliasClasses = [
  ['js', 'javascript'],
  ['ts', 'typescript'],
  ['postgres', 'postgresql'],
  ['k8s', 'kubernetes'],
  ['rag', 'retrieval augmented generation'],
  ['llm', 'large language model', 'large language models'],
  ['genai', 'generative ai'],
] as const;

function normalizedText(value: string): string {
  return value.normalize('NFKC')
    .toLowerCase()
    .replace(/^mailto:|^tel:/u, '')
    .replace(/[‐‑‒–—―]/gu, '-')
    .replace(/[^\p{L}\p{N}+#@._:/% -]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function searchableText(value: string): string {
  return ` ${normalizedText(value).replace(/[^\p{L}\p{N}+#]+/gu, ' ').replace(/\s+/gu, ' ').trim()} `;
}

function hasPhrase(source: string, phrase: string): boolean {
  const needle = searchableText(phrase).trim();
  return needle.length > 0 && searchableText(source).includes(` ${needle} `);
}

function aliasCandidates(value: string): readonly string[] {
  const normalized = normalizedText(value);
  const aliases = aliasClasses.find((group) => group.some((alias) => normalized === alias));
  return aliases ?? [normalized];
}

function hasEvidence(source: string, value: string): boolean {
  return aliasCandidates(value).some((candidate) => hasPhrase(source, candidate));
}

function canonicalNumber(raw: string): string {
  const compact = raw.toLowerCase().replace(/[\s_']/gu, '');
  const suffix = /(?:%|[kmкм])$/u.exec(compact)?.[0] ?? '';
  const numeric = suffix ? compact.slice(0, -suffix.length) : compact;
  const sign = numeric.startsWith('-') || numeric.startsWith('+') ? numeric[0]! : '';
  const unsigned = sign ? numeric.slice(1) : numeric;
  const lastComma = unsigned.lastIndexOf(',');
  const lastDot = unsigned.lastIndexOf('.');
  const separator = Math.max(lastComma, lastDot);
  let normalized: string;
  if (separator >= 0 && unsigned.length - separator - 1 <= 2) {
    normalized = `${unsigned.slice(0, separator).replace(/[.,]/gu, '')}.${unsigned.slice(separator + 1)}`;
  } else {
    normalized = unsigned.replace(/[.,]/gu, '');
  }
  return `${sign}${normalized.replace(/^0+(?=\d)/u, '') || '0'}${suffix}`;
}

function numberClaims(value: string): string[] {
  // Digits inside identifiers such as K8s, ISO27001, or Invented0 are names, not standalone numeric claims.
  const matches = value.normalize('NFKC')
    .match(/(?<![\p{L}\p{N}])[+-]?\d(?:[\d\s_']*\d)?(?:[.,]\d+)?\s*(?:%|[kKmMкКмМ])?(?![\p{L}\p{N}])/gu) ?? [];
  return matches.map(canonicalNumber);
}

function blockText(block: CvBlock): string[] {
  switch (block.kind) {
    case 'text': return [block.text];
    case 'bullets': return block.items;
    case 'entry': return [
      block.title,
      ...(block.subtitle ? [block.subtitle] : []),
      ...(block.meta ? [block.meta] : []),
      ...(block.text ? [block.text] : []),
      ...(block.bullets ?? []),
    ];
    case 'facts': return block.items.flatMap((fact) => [fact.term, fact.detail]);
  }
}

function documentText(document: CvDocument): string[] {
  return [
    document.name,
    ...(document.headline ? [document.headline] : []),
    ...document.contacts,
    ...document.sections.flatMap((section) => [section.title, ...section.blocks.flatMap(blockText)]),
  ];
}

function contactEvidence(source: string, contact: string): boolean {
  const normalizedSource = normalizedText(source).replace(/\/$/u, '');
  const normalizedContact = normalizedText(contact).replace(/\/$/u, '');
  return normalizedContact.length > 0 && normalizedSource.includes(normalizedContact);
}

function skillValues(detail: string): string[] {
  return detail.split(/\s*(?:[,;|•]|\s\/\s)\s*/u).map((value) => value.trim()).filter(Boolean);
}

/** Returns deterministic factual deviations from the authoritative CV without invoking another model. */
export function tailoredCvEvidenceIssues(document: CvDocument, authoritativeText: string): CvEvidenceIssue[] {
  const issues: CvEvidenceIssue[] = [];
  const seen = new Set<string>();
  const add = (kind: CvEvidenceIssue['kind'], value: string): void => {
    const cleaned = value.trim();
    const key = `${kind}\0${normalizedText(cleaned)}`;
    if (!cleaned || seen.has(key)) return;
    seen.add(key);
    issues.push(Object.freeze({ kind, value: cleaned }));
  };

  const sourceNumbers = new Set(numberClaims(authoritativeText));
  for (const value of documentText(document)) {
    for (const number of numberClaims(value)) if (!sourceNumbers.has(number)) add('new-number', number);
  }
  for (const contact of document.contacts) {
    if (!contactEvidence(authoritativeText, contact)) add('unknown-contact', contact);
  }
  for (const section of document.sections) {
    for (const block of section.blocks) {
      if (block.kind === 'entry' && !hasEvidence(authoritativeText, block.title)) {
        add('unknown-entry', block.title);
      }
      if (block.kind === 'facts' && skillTerms.has(normalizedText(block.items[0]?.term ?? ''))) {
        for (const fact of block.items) {
          if (!skillTerms.has(normalizedText(fact.term))) continue;
          for (const skill of skillValues(fact.detail)) {
            if (!hasEvidence(authoritativeText, skill)) add('unsupported-skill', skill);
          }
        }
      }
    }
  }
  return issues;
}

export class CvEvidenceError extends Error {
  readonly issues: readonly CvEvidenceIssue[];

  constructor(issues: readonly CvEvidenceIssue[]) {
    const summary = issues.slice(0, 8).map((issue) => `${issue.kind}: ${issue.value}`).join('; ');
    const remaining = Math.max(0, issues.length - 8);
    super(`Tailored CV contains unsupported evidence: ${summary}${remaining ? `; and ${remaining} more` : ''}.`);
    this.name = 'CvEvidenceError';
    this.issues = Object.freeze([...issues]);
  }
}

export function assertTailoredCvEvidence(document: CvDocument, authoritativeText: string): void {
  const issues = tailoredCvEvidenceIssues(document, authoritativeText);
  if (issues.length > 0) throw new CvEvidenceError(issues);
}
