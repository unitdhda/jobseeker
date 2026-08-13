import {
  buildIdfVocabulary,
  createIdfLookup,
  uniformIdfLookups,
  type IdfLookups,
  type IdfVocabulary,
} from '@jobseeker/engine/idf';
import {
  createRoleTokenResolver,
  identityRoleResolver,
  mineRoleEquivalences,
  type RoleEquivalencePair,
  type RoleTokenResolver,
  type RoleTrackTitles,
} from '@jobseeker/engine/equivalence';
import { searchTokens } from '@jobseeker/engine/canon';

export interface MatchingVocabularySnapshot {
  readonly roleResolver: RoleTokenResolver;
  readonly idfLookups: IdfLookups;
  readonly loaded: boolean;
  readonly rebuiltAt: Date | null;
}
export interface MatchingVocabularyPorts {
  loadRoleEquivalences(): Promise<readonly RoleEquivalencePair[]>;
  loadIdfVocabulary(scope: 'title' | 'body'): Promise<IdfVocabulary | null>;
  roleTrackTitles(): Promise<readonly RoleTrackTitles[]>;
  vacancyTextBatch(afterId: number, limit: number): Promise<readonly {
    readonly id: number; readonly title: string; readonly body: string;
  }[]>;
  replaceRoleEquivalences(pairs: readonly RoleEquivalencePair[]): Promise<void>;
  replaceMatchingVocabularies(input: {
    readonly equivalences: readonly RoleEquivalencePair[];
    readonly title: IdfVocabulary;
    readonly body: IdfVocabulary;
  }): Promise<void>;
}

export interface MatchingVocabularies {
  snapshot(): MatchingVocabularySnapshot;
  load(): Promise<MatchingVocabularySnapshot>;
  refreshEquivalences(): Promise<MatchingVocabularySnapshot>;
  rebuild(): Promise<MatchingVocabularySnapshot>;
}

function initialSnapshot(): MatchingVocabularySnapshot {
  return Object.freeze({ roleResolver: identityRoleResolver, idfLookups: uniformIdfLookups, loaded: false, rebuiltAt: null });
}
function published(pairs: readonly RoleEquivalencePair[], title: IdfVocabulary | null, body: IdfVocabulary | null,
  rebuiltAt: Date | null): MatchingVocabularySnapshot {
  return Object.freeze({
    roleResolver: createRoleTokenResolver(pairs),
    idfLookups: Object.freeze({ title: title ? createIdfLookup(title) : uniformIdfLookups.title,
      body: body ? createIdfLookup(body) : uniformIdfLookups.body }),
    loaded: true,
    rebuiltAt: rebuiltAt ? new Date(rebuiltAt) : null,
  });
}

export function createMatchingVocabularies(ports: MatchingVocabularyPorts, options: { readonly corpusBatchSize?: number } = {}): MatchingVocabularies {
  const batchSize = options.corpusBatchSize ?? 1_000;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
    throw new RangeError('Invalid matching-vocabulary corpus batch size.');
  }
  let current = initialSnapshot();
  let chain: Promise<void> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = chain.then(operation, operation);
    chain = result.then(() => undefined, () => undefined);
    return result;
  };

  return Object.freeze({
    snapshot: () => current,
    load: () => serialize(async () => {
      const [pairs, title, body] = await Promise.all([
        ports.loadRoleEquivalences(), ports.loadIdfVocabulary('title'), ports.loadIdfVocabulary('body'),
      ]);
      const next = published(pairs, title, body, null);
      current = next;
      return next;
    }),
    refreshEquivalences: () => serialize(async () => {
      const pairs = mineRoleEquivalences(await ports.roleTrackTitles());
      await ports.replaceRoleEquivalences(pairs);
      const next = Object.freeze({ ...current, roleResolver: createRoleTokenResolver(pairs), loaded: true });
      current = next;
      return next;
    }),
    rebuild: () => serialize(async () => {
      const tracks = await ports.roleTrackTitles();
      const pairs = mineRoleEquivalences(tracks);
      const titleDocuments: string[][] = []; const bodyDocuments: string[][] = [];
      let afterId = 0;
      for (;;) {
        const rows = await ports.vacancyTextBatch(afterId, batchSize);
        if (rows.length === 0) break;
        for (const row of rows) {
          if (!Number.isSafeInteger(row.id) || row.id <= afterId) {
            throw new TypeError('Vacancy corpus must be strictly ordered by positive ID.');
          }
          afterId = row.id;
          titleDocuments.push([...searchTokens(row.title)]);
          bodyDocuments.push([...searchTokens(row.body)]);
        }
        if (rows.length < batchSize) break;
      }
      const title = buildIdfVocabulary(titleDocuments); const body = buildIdfVocabulary(bodyDocuments);
      await ports.replaceMatchingVocabularies({ equivalences: pairs, title, body });
      const next = published(pairs, title, body, new Date());
      current = next;
      return next;
    }),
  });
}
