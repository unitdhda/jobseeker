/**
 * Fills the example toolkit from the real modules, exactly as the application's extension api does at load time.
 * Example tests import this for its side effect before importing any provider.
 */
import * as sourcesLib from '../src/index.ts';
import * as apiDriver from '../src/drivers/api.ts';
import * as atsDriver from '../src/drivers/ats.ts';
import * as companySiteDriver from '../src/drivers/company-site.ts';
import * as jsonLdBoardDriver from '../src/drivers/jsonld-board.ts';
import { initToolkit, type SourceExtensionApi } from '../examples/toolkit.ts';

export const registered: unknown[] = [];

export const exampleApi: SourceExtensionApi = {
  registerSourceProvider: (provider) => { registered.push(provider); },
  env: {},
  sources: Object.assign(Object.create(null) as object, sourcesLib, {
    drivers: { api: apiDriver, ats: atsDriver, companySite: companySiteDriver, jsonLdBoard: jsonLdBoardDriver },
  }) as SourceExtensionApi['sources'],
};

initToolkit(exampleApi);
