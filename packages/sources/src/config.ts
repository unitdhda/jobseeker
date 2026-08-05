/** The knobs and app services the adapters use. The app snapshots settings from its config at composition. */
export interface SourcesSettings {
  searchNewVacancyLimit: number;
  searchPageBudgetPerPlatform: number;
  hhMaxPages: number;
  hhAreaId: string;
  hhBrowserDataPath: string;
  hhOperationTimeoutSeconds: number;
  hireHiMaxPages: number;
  additionalMaxPages: number;
  playwrightHeadless: boolean;
  playwrightChromiumPath: string | undefined;
  timezone: string;
  /** Parsed by the app from ATS_BOARDS; empty means the adapter discovers nothing. */
  atsBoards: readonly string[];
  /** Parsed by the app from TRUDVSEM_REGION. */
  trudvsemRegion: string | undefined;
}

export interface SourcesOptions {
  settings: SourcesSettings;
  /** Observability stays an app concern; adapters only emit through what they are given. */
  trace(event: string, data?: unknown): void;
  /** Redacting formatter — security-sensitive, so it is injected rather than duplicated. */
  errorMessage(error: unknown): string;
}

let options: SourcesOptions | undefined;

/** Same init-once contract as the store: first call wins, and use before configuration throws. */
export function configureSources(provided: SourcesOptions): void {
  options ??= provided;
}

export function sourcesSettings(): SourcesSettings {
  if (!options) throw new Error('configureSources must run before the sources are used.');
  return options.settings;
}

export const trace = (event: string, data?: unknown): void => {
  if (!options) throw new Error('configureSources must run before the sources are used.');
  options.trace(event, data);
};

export const errorMessage = (error: unknown): string => {
  if (!options) throw new Error('configureSources must run before the sources are used.');
  return options.errorMessage(error);
};
