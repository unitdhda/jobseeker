import { createHash } from 'node:crypto';
import { extractCvDocumentIsolated } from './cv-parser-client.ts';
import { clearSearchProfile, requireApprovedUser, saveCvSource } from './database.ts';
import { searchPlatformIds } from '../platforms/registry.ts';
import { careerProfilePlatformId } from './career-profile.ts';

export async function importCvSource(userId: string, filename: string,
  mediaType: string | undefined, bytes: Uint8Array): Promise<void> {
  const extracted = await extractCvDocumentIsolated(filename, mediaType, bytes);
  await requireApprovedUser(userId);
  const hash = createHash('sha256').update(bytes).digest('hex');
  await saveCvSource(userId, filename, hash, extracted);
  for (const platformId of [...searchPlatformIds, careerProfilePlatformId]) await clearSearchProfile(userId, platformId);
}
