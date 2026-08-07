import {
  atsHosts, atsProviders, atsSearchProfileSchema, configuredBoards, createAtsSource, postingMatchesQuery,
  type AtsProvider,
} from '@jobseeker/sources/drivers/ats';

export {
  atsHosts, atsProviders, atsSearchProfileSchema, configuredBoards, postingMatchesQuery,
  type AtsProvider,
};

/** Application-owned identity and board configuration over the reusable grouped ATS driver. */
export function atsSource(options: { boards?: readonly string[] } = {}) {
  return createAtsSource({ id: 'ats', name: 'Company ATS boards' }, options);
}
