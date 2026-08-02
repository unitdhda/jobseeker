import {
  claimBackgroundTask, completeBackgroundTask, failBackgroundTask, renewBackgroundTaskLease,
  saveBackgroundTaskCheckpoint, type BackgroundTask, type JsonObject,
} from './background-tasks.ts';
import { errorMessage } from './logging.ts';

export interface BackgroundTaskContext {
  signal: AbortSignal;
  checkpoint(patch: JsonObject): Promise<JsonObject>;
}
export type BackgroundTaskHandler = (task: BackgroundTask, context: BackgroundTaskContext) => Promise<JsonObject | void>;
export type BackgroundTaskExecutionOutcome = 'completed' | 'retrying' | 'failed' | 'lease-lost';

export class PermanentTaskError extends Error {
  override readonly name = 'PermanentTaskError';
}

export interface BackgroundTaskWorkerOptions {
  workerId: string;
  handlers: Record<string, BackgroundTaskHandler>;
  concurrency?: number;
  leaseMs?: number;
  pollIntervalMs?: number;
}

function boundedInteger(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}
function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done,milliseconds);
    function done(): void { clearTimeout(timer); signal.removeEventListener('abort',done); resolve(); }
    signal.addEventListener('abort',done,{ once: true });
  });
}

export class BackgroundTaskWorker {
  readonly #workerId: string;
  readonly #handlers: Record<string, BackgroundTaskHandler>;
  readonly #concurrency: number;
  readonly #leaseMs: number;
  readonly #pollIntervalMs: number;
  readonly #controller = new AbortController();
  #running: Promise<void>[] = [];

  constructor(options: BackgroundTaskWorkerOptions) {
    if (!options.workerId.trim()) throw new Error('workerId is required.');
    if (!Object.keys(options.handlers).length) throw new Error('At least one background task handler is required.');
    this.#workerId=options.workerId;
    this.#handlers={ ...options.handlers };
    this.#concurrency=boundedInteger('concurrency',options.concurrency??1,1,20);
    this.#leaseMs=boundedInteger('leaseMs',options.leaseMs??5*60_000,5_000,60*60_000);
    this.#pollIntervalMs=boundedInteger('pollIntervalMs',options.pollIntervalMs??1_000,50,60_000);
  }

  async runOne(slot=0): Promise<boolean> {
    const task = await claimBackgroundTask({ workerId: `${this.#workerId}:${slot}`, kinds: Object.keys(this.#handlers),
      leaseMs: this.#leaseMs });
    if (!task) return false;
    await this.#execute(task);
    return true;
  }

  async runTask(taskKey: string): Promise<BackgroundTaskExecutionOutcome|null> {
    const task=await claimBackgroundTask({ workerId:`${this.#workerId}:request`,taskKey,kinds:Object.keys(this.#handlers),
      leaseMs:this.#leaseMs });
    return task?this.#execute(task):null;
  }

  start(): void {
    if (this.#running.length) return;
    this.#running=Array.from({ length: this.#concurrency },(_,slot)=>this.#loop(slot));
  }

  async stop(): Promise<void> {
    this.#controller.abort();
    await Promise.allSettled(this.#running);
    this.#running=[];
  }

  async #loop(slot: number): Promise<void> {
    while (!this.#controller.signal.aborted) {
      try {
        if (!await this.runOne(slot)) await wait(this.#pollIntervalMs,this.#controller.signal);
      } catch (error) {
        console.error(`Background task worker loop failed: ${errorMessage(error)}`);
        await wait(this.#pollIntervalMs,this.#controller.signal);
      }
    }
  }

  async #execute(task: BackgroundTask): Promise<BackgroundTaskExecutionOutcome> {
    const handler=this.#handlers[task.kind];
    const taskController=new AbortController();
    const onWorkerAbort=()=>taskController.abort(this.#controller.signal.reason);
    this.#controller.signal.addEventListener('abort',onWorkerAbort,{ once: true });
    let heartbeatTimer: NodeJS.Timeout|undefined;
    let heartbeat: Promise<void>|undefined;
    let leaseFailure: unknown;
    const scheduleHeartbeat=(): void => {
      heartbeatTimer=setTimeout(()=> {
        heartbeat=(async()=> {
          try { await renewBackgroundTaskLease(task.taskKey,task.leaseOwner!,this.#leaseMs); }
          catch (error) { leaseFailure=error; taskController.abort(error); }
          if (!leaseFailure && !taskController.signal.aborted) scheduleHeartbeat();
        })();
      },Math.max(1_000,Math.floor(this.#leaseMs/3)));
    };
    scheduleHeartbeat();
    try {
      if (!handler) throw new PermanentTaskError(`No handler is registered for task kind ${task.kind}.`);
      const finalCheckpoint=await handler(task,{ signal: taskController.signal,
        checkpoint: (patch)=>saveBackgroundTaskCheckpoint(task.taskKey,task.leaseOwner!,patch) });
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      await heartbeat;
      if (leaseFailure) throw leaseFailure;
      await completeBackgroundTask(task.taskKey,task.leaseOwner!,finalCheckpoint||undefined);
      return 'completed';
    } catch (error) {
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      await heartbeat;
      if (leaseFailure) {
        console.error(`Background task lease was lost while running ${task.kind}: ${errorMessage(leaseFailure)}`);
        return 'lease-lost';
      }
      try {
        const outcome=await failBackgroundTask(task.taskKey,task.leaseOwner!,error,
          { retryable:!(error instanceof PermanentTaskError) });
        return outcome==='queued'?'retrying':'failed';
      } catch (failureError) {
        console.error(`Could not persist background task failure for ${task.kind}: ${errorMessage(failureError)}`);
        return 'lease-lost';
      }
    } finally {
      this.#controller.signal.removeEventListener('abort',onWorkerAbort);
    }
  }
}
