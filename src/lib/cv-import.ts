import { createHash } from 'node:crypto';
import { extractCvDocumentIsolated } from './cv-parser-client.ts';
import { clearSearchProfile, requireApprovedUser, saveCvTemplate, type CvLanguage } from './database.ts';
import { searchPlatformIds } from '../platforms/registry.ts';

export async function importCvTemplate(userId: string, language: CvLanguage, filename: string,
  mediaType: string | undefined, bytes: Uint8Array): Promise<void> {
  const extracted = await extractCvDocumentIsolated(filename, mediaType, bytes);
  requireApprovedUser(userId);
  const hash = createHash('sha256').update(bytes).digest('hex');
  saveCvTemplate(userId, language, filename, hash, extracted);
  for (const platformId of searchPlatformIds) clearSearchProfile(userId, platformId);
}
