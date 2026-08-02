import { recordVacancyCandidate, type VacancyCandidateInput } from './database.ts';

export interface VacancySearchResult { seen: number; discovered: number }

/** Records unique search results until the per-user/platform new-vacancy target is reached. */
export class VacancySearchCollector {
  readonly #seen = new Set<string>();
  #discovered = 0;

  constructor(readonly userId: string, readonly newVacancyLimit: number) {}

  get complete(): boolean { return this.#discovered >= this.newVacancyLimit; }

  record(input: VacancyCandidateInput): boolean {
    const key = `${input.source}:${input.sourceId}`;
    if (this.complete || this.#seen.has(key)) return false;
    this.#seen.add(key);
    if (recordVacancyCandidate(this.userId, input)) this.#discovered++;
    return true;
  }

  result(): VacancySearchResult {
    return { seen: this.#seen.size, discovered: this.#discovered };
  }
}
