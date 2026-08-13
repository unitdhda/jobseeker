
import { createCvPdf } from '@jobseeker/cv/pdf';
import { composeApplication } from './composition.ts';
import { config } from './config.ts';
import { createMatchingVocabularies } from './matching-vocabularies.ts';
import { createJobWorkerHandlers } from './workflow-adapters.ts';
import { packageAssetPath } from './deployment-paths.ts';

const composition = await composeApplication({ ...config, telegramMode: 'off', engineMode: 'off' });
const vocabularies = createMatchingVocabularies({
  loadRoleEquivalences: composition.store.loadRoleEquivalences,
  loadIdfVocabulary: composition.store.loadIdfVocabulary,
  roleTrackTitles: composition.store.roleTrackTitles,
  vacancyTextBatch: composition.store.vacancyTextBatch,
  replaceRoleEquivalences: composition.store.replaceRoleEquivalences,
  replaceMatchingVocabularies: composition.store.replaceMatchingVocabularies,
});
await vocabularies.load();
const fonts = packageAssetPath(import.meta.url, 'fonts');
const handlers = createJobWorkerHandlers({ composition, vocabularies,
  renderer: { render: (document) => createCvPdf({ fontPaths: [fonts] }).compileCvDocument(document) } });

export default Object.freeze({ ...handlers, close: () => composition.close() });
