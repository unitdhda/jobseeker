import pLimit, { type LimitFunction } from 'p-limit';

const jobsPerAdditionalWorker = 5;

function assertNonnegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Invalid ${name}: expected a nonnegative safe integer, received ${value}.`);
  }
}

function assertConcurrencyBounds(minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(minimum) || minimum < 1) {
    throw new RangeError(
      `Invalid minimum concurrency: expected a positive safe integer, received ${minimum}.`,
    );
  }
  if (!Number.isSafeInteger(maximum) || maximum < minimum) {
    throw new RangeError(
      `Invalid maximum concurrency: expected a safe integer at least minimum ${minimum}, received ${maximum}.`,
    );
  }
}

/** Returns useful workers: minimum at normal load, then one more per five additional jobs, bounded by load/max. */
export function adaptiveConcurrency(load: number, minimum: number, maximum: number): number {
  assertNonnegativeSafeInteger(load, 'concurrency load');
  assertConcurrencyBounds(minimum, maximum);
  if (load === 0) return 0;
  if (load <= minimum) return load;
  return Math.min(load, maximum, minimum + Math.floor((load - minimum) / jobsPerAdditionalWorker));
}

export class AdaptiveTaskPool {
  private readonly limit: LimitFunction;

  constructor(readonly minimum: number, readonly maximum: number) {
    assertConcurrencyBounds(minimum, maximum);
    this.limit = pLimit(minimum);
  }

  get activeCount(): number {
    return this.limit.activeCount;
  }

  get queuedCount(): number {
    return this.limit.pendingCount;
  }

  get concurrency(): number {
    return this.limit.concurrency;
  }

  run<T>(task: () => PromiseLike<T> | T): Promise<T> {
    if (typeof task !== 'function') throw new TypeError('Invalid task: expected a function.');
    const incomingLoad = this.limit.activeCount + this.limit.pendingCount + 1;
    this.limit.concurrency = adaptiveConcurrency(incomingLoad, this.minimum, this.maximum);

    return this.limit(task).finally(() => {
      const remainingLoad = this.limit.activeCount + this.limit.pendingCount;
      this.limit.concurrency = remainingLoad === 0
        ? this.minimum
        : adaptiveConcurrency(remainingLoad, this.minimum, this.maximum);
    });
  }
}

export class KeyedTaskScheduler<TKey = string> {
  private readonly pool: AdaptiveTaskPool;
  private readonly tails = new Map<TKey, Promise<void>>();

  constructor(readonly concurrency: number) {
    assertConcurrencyBounds(concurrency, concurrency);
    this.pool = new AdaptiveTaskPool(concurrency, concurrency);
  }

  get activeCount(): number {
    return this.pool.activeCount;
  }

  get queuedCount(): number {
    return this.pool.queuedCount;
  }

  /**
   * Chains each task behind the previous task for its key, while the shared pool bounds work across distinct keys.
   * A separate completion-only tail means a rejected task cannot poison later work for the same key.
   */
  run<T>(key: TKey, task: () => PromiseLike<T> | T): Promise<T> {
    if (typeof task !== 'function') throw new TypeError('Invalid keyed task: expected a function.');
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(key, tail);

    return previous
      .then(() => this.pool.run(task))
      .finally(() => {
        release();
        // Delete only our own tail: another task may have joined this key while this task was running.
        if (this.tails.get(key) === tail) this.tails.delete(key);
      });
  }
}

export interface OrderedProgressAggregator<TKey, TPhase extends string> {
  report(key: TKey, phase: TPhase, current: number, total: number): void;
  done(key: TKey): void;
}

interface ProgressValue {
  current: number;
  total: number;
}

interface KeyProgress {
  phaseIndex: number;
  done: boolean;
  values: ProgressValue[];
}

function assertProgressValue(current: number, total: number): void {
  if (!Number.isFinite(current) || current < 0) {
    throw new RangeError(`Invalid progress current value: expected a finite nonnegative number, received ${current}.`);
  }
  if (!Number.isFinite(total) || total < 0) {
    throw new RangeError(`Invalid progress total value: expected a finite nonnegative number, received ${total}.`);
  }
  if (current > total) {
    throw new RangeError(`Invalid progress value: current ${current} must not exceed total ${total}.`);
  }
}

/** Aggregates concurrent key progress while emitting only the earliest globally incomplete ordered phase. */
export function aggregateOrderedProgress<TKey, TPhase extends string>(
  keys: readonly TKey[],
  phases: readonly TPhase[],
  update: (phase: TPhase, current: number, total: number) => void,
): OrderedProgressAggregator<TKey, TPhase> {
  if (phases.length === 0) throw new RangeError('Invalid progress phases: expected at least one phase.');
  if (new Set(phases).size !== phases.length) throw new TypeError('Invalid progress phases: duplicate phase encountered.');
  if (new Set(keys).size !== keys.length) throw new TypeError('Invalid progress keys: duplicate key encountered.');
  if (typeof update !== 'function') throw new TypeError('Invalid progress update: expected a function.');

  const phaseIndexes = new Map(phases.map((phase, index) => [phase, index]));
  const states = new Map<TKey, KeyProgress>(keys.map((key) => [key, {
    phaseIndex: -1,
    done: false,
    values: phases.map(() => ({ current: 0, total: 0 })),
  }]));
  let lastEmission: { phaseIndex: number; current: number; total: number } | undefined;

  const emit = (): void => {
    const values = [...states.values()];
    // Wait until every concurrent key has reported once; otherwise aggregate totals would jump as keys appear.
    if (values.length === 0 || values.some((state) => state.phaseIndex < 0)) return;
    // The slowest key owns the visible phase, preventing later phases from overtaking earlier incomplete work.
    const phaseIndex = Math.min(...values.map((state) => state.phaseIndex));
    const current = values.reduce((sum, state) => sum + state.values[phaseIndex]!.current, 0);
    const total = values.reduce((sum, state) => sum + state.values[phaseIndex]!.total, 0);
    if (lastEmission?.phaseIndex === phaseIndex
      && lastEmission.current === current
      && lastEmission.total === total) return;
    lastEmission = { phaseIndex, current, total };
    update(phases[phaseIndex]!, current, total);
  };

  return Object.freeze({
    report(key: TKey, phase: TPhase, current: number, total: number): void {
      assertProgressValue(current, total);
      const state = states.get(key);
      const phaseIndex = phaseIndexes.get(phase);
      if (!state || state.done || phaseIndex === undefined || phaseIndex < state.phaseIndex) return;

      // Entering a later phase is an implicit declaration that every earlier phase for this key completed.
      while (state.phaseIndex < phaseIndex) {
        if (state.phaseIndex >= 0) {
          const prior = state.values[state.phaseIndex]!;
          prior.current = prior.total;
        }
        state.phaseIndex += 1;
      }
      const progress = state.values[phaseIndex]!;
      // Concurrent producers may discover larger totals; neither total nor completed work is allowed to regress.
      progress.total = Math.max(progress.total, total);
      progress.current = Math.max(progress.current, current);
      emit();
    },

    done(key: TKey): void {
      const state = states.get(key);
      if (!state || state.done) return;
      if (state.phaseIndex >= 0) {
        const current = state.values[state.phaseIndex]!;
        current.current = current.total;
      }
      for (let index = state.phaseIndex + 1; index < phases.length; index += 1) {
        state.values[index]!.current = state.values[index]!.total;
      }
      state.phaseIndex = phases.length - 1;
      state.done = true;
      emit();
    },
  });
}

/** Runs a bounded mapper while Promise.all preserves the input-indexed result order. */
export function mapConcurrent<T, TResult>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => PromiseLike<TResult> | TResult,
): Promise<TResult[]> {
  assertConcurrencyBounds(concurrency, concurrency);
  if (typeof mapper !== 'function') throw new TypeError('Invalid concurrent mapper: expected a function.');
  const limit = pLimit(concurrency);
  return Promise.all([...items].map((item, index) => limit(mapper, item, index)));
}
