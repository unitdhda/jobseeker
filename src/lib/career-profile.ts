import * as v from 'valibot';

const evidenceText = v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(300));
const label = v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(100));
const title = v.pipe(label,v.check((value) => !/\s[\/|]\s/.test(value),
  'Each title variant must contain one title in one language; put translations in separate array items.'));

export const careerTrackSchema = v.strictObject({
  name: label,
  titleVariants: v.pipe(v.array(title), v.minLength(1), v.maxLength(16)),
  coreSkills: v.pipe(v.array(label), v.maxLength(30)),
  evidence: v.pipe(v.array(evidenceText), v.minLength(1), v.maxLength(8)),
});

export const careerProfileSchema = v.strictObject({
  version: v.literal(1),
  tracks: v.pipe(v.array(careerTrackSchema), v.minLength(1), v.maxLength(10)),
});

export type CareerTrack = v.InferOutput<typeof careerTrackSchema>;
export type CareerProfile = v.InferOutput<typeof careerProfileSchema>;

export const careerProfilePlatformId = '__career-profile-v1';

export interface StoredCareerProfile {
  cvHash: string;
  profile: CareerProfile;
}

export function parseStoredCareerProfile(value: unknown, expectedCvHash: string): CareerProfile | null {
  if (!value || typeof value !== 'object') return null;
  const stored = value as Partial<StoredCareerProfile>;
  if (stored.cvHash !== expectedCvHash) return null;
  const parsed = v.safeParse(careerProfileSchema, stored.profile);
  return parsed.success ? parsed.output : null;
}
