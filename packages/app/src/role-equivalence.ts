/**
 * The application's live role-equivalence state: mined from approved users' career profiles, persisted for other
 * processes, held in memory as a resolver the prefilter and demand compiler consult at compare time.
 *
 * Refresh points: engine-loop start and the daily calibrate stage. A failed refresh keeps the previous resolver —
 * matching narrows gracefully rather than erroring.
 */
import {
  careerProfilePlatformId, createRoleTokenResolver, identityRoleResolver, mineRoleEquivalences,
  parseStoredCareerProfile, type RoleTokenResolver, type StoredCareerProfile,
} from '@jobseeker/engine';
import {
  approvedUsers, getCvSource, getSearchProfile, loadRoleEquivalences, replaceRoleEquivalences,
} from './postgres.ts';
import { errorMessage } from './observability.ts';

let resolver: RoleTokenResolver = identityRoleResolver;

export function roleTokenResolver(): RoleTokenResolver {
  return (token) => resolver(token);
}

/** Loads the persisted pairs without mining — cheap enough for process start. */
export async function loadRoleEquivalenceResolver(): Promise<void> {
  resolver = createRoleTokenResolver(await loadRoleEquivalences());
}

/** Re-mines from every approved user's current career profile and persists the result. */
export async function refreshRoleEquivalences(): Promise<number> {
  const tracks: { titleVariants: readonly string[] }[] = [];
  for (const user of await approvedUsers(true)) {
    const cv = await getCvSource(user.userId);
    if (!cv) continue;
    const profile = parseStoredCareerProfile(
      await getSearchProfile<StoredCareerProfile>(user.userId, careerProfilePlatformId), cv.cvSha256);
    if (profile) tracks.push(...profile.tracks);
  }
  const pairs = mineRoleEquivalences(tracks);
  await replaceRoleEquivalences(pairs);
  resolver = createRoleTokenResolver(pairs);
  return pairs.length;
}

export async function tryRefreshRoleEquivalences(): Promise<void> {
  try {
    const pairs = await refreshRoleEquivalences();
    console.info(`Role equivalences refreshed: ${pairs} pairs mined from career profiles.`);
  } catch (error) {
    console.error(`Role-equivalence refresh failed; keeping the previous vocabulary: ${errorMessage(error)}`);
  }
}
