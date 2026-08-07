/**
 * Registers the example source providers shipped with @jobseeker/sources. This file is itself an example: delete
 * it or edit the list to control which sources a deployment runs, and use SEARCH_PLATFORMS to narrow discovery
 * without unregistering anything.
 */
import type { JobseekerExtensionApi } from './extension-api.ts';

export default function register(api: JobseekerExtensionApi): void {
  const maxPages = Number(api.env.ADDITIONAL_MAX_PAGES) || 1;
  for (const provider of api.sources.examples.exampleSources({
    maxPages,
    atsBoards: (api.env.ATS_BOARDS ?? '').split(',').map((entry) => entry.trim()).filter(Boolean),
    trudvsemRegion: api.env.TRUDVSEM_REGION?.trim() || undefined,
  })) api.registerSourceProvider(provider);
}
