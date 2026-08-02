import { defineTool, type JsonValue } from '@flue/runtime';
import * as v from 'valibot';
import { getCvHash, getSearchProfile, requireApprovedUser, saveSearchProfile } from '../lib/database.ts';
import { getSearchPlatform } from '../platforms/registry.ts';
import { trace } from '../lib/trace.ts';
import { careerProfilePlatformId, parseStoredCareerProfile, type StoredCareerProfile } from '../lib/career-profile.ts';

export function searchProfileTools(userId: string, platformId: string, expectedCvHash: string) {
  const platform = getSearchPlatform(platformId);
  return [
    defineTool({
      name: 'load_search_capabilities',
      description: 'Load the platform-specific JSON template, allowed search inputs, IDs, and validation rules. Always call first.',
      async run() {
        const output = JSON.parse(JSON.stringify(platform.template())) as JsonValue;
        const careerProfile = parseStoredCareerProfile(
          await getSearchProfile<StoredCareerProfile>(userId, careerProfilePlatformId), expectedCvHash,
        );
        if (!careerProfile) throw new Error('A CV-derived career profile is required before platform mapping.');
        const result = { ...(output as Record<string, JsonValue>), cvDerivedCareerProfile: careerProfile as unknown as JsonValue };
        trace('tool.load_search_capabilities.output', { platform: platform.id, output: result });
        return result;
      },
    }),
    defineTool({
      name: 'validate_and_save_search_profile',
      description: 'Validate a candidate JSON profile against this platform template and save it. Fix validation errors and retry.',
      input: v.object({ profile: v.unknown() }),
      async run({ data }) {
        await requireApprovedUser(userId);
        if (await getCvHash(userId) !== expectedCvHash) throw new Error('CV changed during profile generation.');
        const result = v.safeParse(platform.schema, data.profile);
        trace('tool.validate_search_profile.input', { platform: platform.id, profile: data.profile });
        if (!result.success) {
          const errors = result.issues.slice(0, 12).map((issue) => ({
            path: v.getDotPath(issue) ?? '(root)', message: issue.message,
          }));
          trace('tool.validate_search_profile.rejected', { platform: platform.id, errors });
          throw new Error(`Search profile validation failed: ${JSON.stringify(errors)}`);
        }
        await saveSearchProfile(userId, platform.id, result.output);
        const output = { valid: true, platform: platform.id };
        trace('tool.validate_search_profile.output', { ...output, profile: result.output });
        return output;
      },
    }),
  ] as const;
}
