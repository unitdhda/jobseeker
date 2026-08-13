import { createEngineLoop, type EngineLoop, type LoopPorts, type LaneClock } from '@jobseeker/engine/loop';
import type { Store } from '@jobseeker/store';
import type { MutableSources } from '@jobseeker/sources';
import type { LoadedExtensions } from './extensions.ts';
import type { MatchingVocabularies } from './matching-vocabularies.ts';

export interface EngineOwnershipOptions {
  readonly store: Pick<Store, 'tryAcquireSingletonLock'>;
  readonly sources: Pick<MutableSources, 'close'>;
  readonly extensions: Pick<LoadedExtensions, 'startupHooks' | 'shutdownHooks'>;
  readonly vocabularies: MatchingVocabularies;
  readonly ports: LoopPorts;
  readonly clocks: { readonly discovery: LaneClock; readonly judgment: LaneClock };
  readonly log?: (message: string) => void;
  readonly createLoop?: typeof createEngineLoop;
}
export interface EngineOwnership {
  readonly ownsLock: boolean;
  readonly loop: EngineLoop | null;
  readonly run: Promise<void>;
  stop(): Promise<void>;
}

export async function startEngineOwnership(options: EngineOwnershipOptions): Promise<EngineOwnership> {
  const release = await options.store.tryAcquireSingletonLock('jobseeker-engine-loop');
  if (!release) {
    options.log?.('Engine lock is held by another process; this process is idle.');
    return Object.freeze({ ownsLock: false, loop: null, run: Promise.resolve(), stop: async () => undefined });
  }
  let loop: EngineLoop | null = null; let run: Promise<void> = Promise.resolve(); let stopPromise: Promise<void> | undefined;
  try {
    await options.vocabularies.load();
    for (const hook of options.extensions.startupHooks) await hook();
    loop = (options.createLoop ?? createEngineLoop)(options.ports, options.clocks);
    run = loop.run();
  } catch (error) {
    await options.sources.close().catch(() => undefined);
    for (const hook of [...options.extensions.shutdownHooks].reverse()) {
      // Shutdown hooks must be safe before their own resource starts; registrations are not positionally paired.
      await Promise.resolve().then(() => hook()).catch(() => undefined);
    }
    await release().catch(() => undefined);
    throw error;
  }
  const activeLoop = loop;
  return Object.freeze({
    ownsLock: true,
    loop: activeLoop,
    run,
    stop(): Promise<void> {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        const failures: unknown[] = [];
        activeLoop.stop();
        await run.catch((error) => failures.push(error));
        await options.sources.close().catch((error) => failures.push(error));
        for (const hook of [...options.extensions.shutdownHooks].reverse()) {
          try { await hook(); } catch (error) { failures.push(error); }
        }
        await release().catch((error) => failures.push(error));
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, 'Engine shutdown failed.');
      })();
      return stopPromise;
    },
  });
}
