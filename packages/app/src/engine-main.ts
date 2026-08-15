import { createEngineLoop, type EngineLoop, type LoopPorts, type LaneClock } from '@jobseeker/engine/loop';
import type { Store } from '@jobseeker/store';
import type { MutableSources } from '@jobseeker/sources';
import type { LoadedExtensions } from './extensions.ts';
import type { MatchingVocabularies } from './matching-vocabularies.ts';

export type EngineOwnershipState = 'waiting' | 'running' | 'recovering' | 'stopped';
export interface EngineOwnershipOptions {
  readonly store: Pick<Store, 'tryAcquireSingletonLock'>;
  readonly sources: Pick<MutableSources, 'close'>;
  readonly extensions: Pick<LoadedExtensions, 'startupHooks' | 'shutdownHooks'>;
  readonly vocabularies: MatchingVocabularies;
  readonly ports: LoopPorts;
  readonly clocks: { readonly discovery: LaneClock; readonly judgment: LaneClock };
  readonly log?: (message: string) => void;
  readonly createLoop?: typeof createEngineLoop;
  readonly retryDelayMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}
export interface EngineOwnershipStatus {
  readonly state: EngineOwnershipState;
  readonly ownsLock: boolean;
  readonly loop: EngineLoop | null;
}
export interface EngineOwnership {
  readonly ownsLock: boolean;
  readonly loop: EngineLoop | null;
  readonly run: Promise<void>;
  status(): EngineOwnershipStatus;
  stop(): Promise<void>;
}

/** Supervises the engine's session lock so stale pooler leases and connection loss recover without process restart. */
export async function startEngineOwnership(options: EngineOwnershipOptions): Promise<EngineOwnership> {
  const retryDelayMs = options.retryDelayMs ?? 5_000;
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) throw new RangeError('Engine retry delay must be nonnegative.');
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let state: EngineOwnershipState = 'waiting'; let stopped = false; let initialized = false; let resourcesClosed = false;
  let lease: Awaited<ReturnType<EngineOwnershipOptions['store']['tryAcquireSingletonLock']>> = null;
  let loop: EngineLoop | null = null; let loopRun: Promise<void> | null = null; let stopPromise: Promise<void> | undefined;
  let releaseStop!: () => void;
  const stopSignal = new Promise<void>((resolve) => { releaseStop = resolve; });

  const safeLog = (message: string): void => { options.log?.(message); };
  const waitToRetry = async (): Promise<void> => { await Promise.race([sleep(retryDelayMs), stopSignal]); };
  const stopLoop = async (): Promise<void> => {
    const activeLoop = loop; const activeRun = loopRun;
    loop = null; loopRun = null;
    if (!activeLoop) return;
    activeLoop.stop();
    await activeRun?.catch(() => undefined);
  };
  const releaseLease = async (): Promise<void> => {
    const active = lease; lease = null;
    await active?.release().catch(() => undefined);
  };
  const closeResources = async (): Promise<void> => {
    if (resourcesClosed || !initialized) return;
    resourcesClosed = true;
    const failures: unknown[] = [];
    await options.sources.close().catch((error) => failures.push(error));
    for (const hook of [...options.extensions.shutdownHooks].reverse()) {
      try { await hook(); } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Engine resource shutdown failed.');
  };
  const initialize = async (): Promise<void> => {
    if (initialized) return;
    try {
      await options.vocabularies.load();
      for (const hook of options.extensions.startupHooks) await hook();
      initialized = true;
    } catch (error) {
      // Startup hooks are required to be safe before their own resource starts.
      initialized = true;
      await closeResources().catch(() => undefined);
      throw error;
    }
  };
  const acquire = async (): Promise<boolean> => {
    try {
      lease = await options.store.tryAcquireSingletonLock('jobseeker-engine-loop');
    } catch {
      state = 'recovering';
      safeLog('Engine ownership database connection failed; retrying.');
      return false;
    }
    if (!lease) {
      state = 'waiting';
      safeLog('Engine ownership is held elsewhere; waiting.');
      return false;
    }
    await initialize();
    if (stopped) { await releaseLease(); return false; }
    loop = (options.createLoop ?? createEngineLoop)(options.ports, options.clocks);
    loopRun = loop.run();
    state = 'running';
    safeLog('Engine ownership acquired.');
    return true;
  };

  // Preserve startup failure semantics for resource initialization while allowing lock contention/DB failure to recover.
  try { await acquire(); } catch (error) { await releaseLease(); throw error; }

  const supervise = async (): Promise<void> => {
    try {
      while (!stopped) {
        if (!lease) {
          await waitToRetry();
          if (stopped) break;
          try { await acquire(); }
          catch {
            state = 'recovering';
            safeLog('Engine resource initialization failed.');
            break;
          }
          continue;
        }
        const activeLease = lease; const activeRun = loopRun ?? Promise.resolve();
        const outcome = await Promise.race([
          activeLease.lost.then(() => 'lost' as const),
          activeRun.then(() => 'ended' as const, () => 'ended' as const),
          stopSignal.then(() => 'stopped' as const),
        ]);
        if (outcome === 'stopped') break;
        state = 'recovering';
        safeLog(outcome === 'lost' ? 'Engine ownership connection was lost; recovering.' : 'Engine loop stopped; recovering.');
        await stopLoop();
        await releaseLease();
      }
    } finally {
      await stopLoop();
      await releaseLease();
      await closeResources();
      state = 'stopped';
    }
  };
  const run = supervise();
  const snapshot = (): EngineOwnershipStatus => Object.freeze({ state, ownsLock: state === 'running' && lease !== null,
    loop: state === 'running' ? loop : null });
  return Object.freeze({
    get ownsLock() { return snapshot().ownsLock; },
    get loop() { return snapshot().loop; },
    run,
    status: snapshot,
    stop(): Promise<void> {
      if (stopPromise) return stopPromise;
      stopped = true; releaseStop();
      stopPromise = run;
      return stopPromise;
    },
  });
}
