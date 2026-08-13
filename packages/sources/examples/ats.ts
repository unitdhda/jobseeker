import { assertToolkitInitialized, createAtsSource, exampleAtsBoards, initToolkit, type SourceExtensionApi } from './toolkit.ts';

export function atsSource(options: { readonly boards?: readonly string[] } = {}) {
  assertToolkitInitialized();
  return createAtsSource({ id: 'ats', name: 'Configured ATS boards' }, { boards: options.boards ?? [] });
}

export default function register(api: SourceExtensionApi): void {
  initToolkit(api);
  api.registerSourceProvider(atsSource({ boards: exampleAtsBoards(api) }));
}
