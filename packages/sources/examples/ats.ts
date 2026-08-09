import type { AtsProvider } from '@jobseeker/sources/drivers/ats';
import { atsHosts, atsProviders, atsSearchProfileSchema, configuredBoards, createAtsSource, exampleAtsBoards, initToolkit, postingMatchesQuery, type SourceExtensionApi } from './toolkit.ts';

export {
  atsHosts, atsProviders, atsSearchProfileSchema, configuredBoards, postingMatchesQuery,
  type AtsProvider,
};

/** Application-owned identity and board configuration over the reusable grouped ATS driver. */
export function atsSource(options: { boards?: readonly string[] } = {}) {
  return createAtsSource({ id: 'ats', name: 'Company ATS boards' }, options);
}

/** Registers this example; the loader calls it once the file sits in an extensions directory. */
export default function register(api: SourceExtensionApi): void {
  initToolkit(api);
  api.registerSourceProvider(atsSource({ boards: exampleAtsBoards(api) }));
}
