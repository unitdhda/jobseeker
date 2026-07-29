export function adaptiveConcurrency(load: number, minimum: number, maximum: number): number {
  const normalizedLoad = Math.max(0, Math.floor(load));
  if (!normalizedLoad) return 0;
  const lower = Math.max(1, Math.floor(minimum));
  const upper = Math.max(lower, Math.floor(maximum));
  if (normalizedLoad < lower) return normalizedLoad;
  const jobsPerAdditionalWorker = 5;
  return Math.min(normalizedLoad, upper,
    lower + Math.floor((normalizedLoad - lower) / jobsPerAdditionalWorker));
}

interface QueuedTask<T> {
  task: () => Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export class AdaptiveTaskPool {
  private readonly queue: QueuedTask<unknown>[] = [];
  private active = 0;

  constructor(readonly minimum: number, readonly maximum: number) {
    if (!Number.isInteger(minimum) || !Number.isInteger(maximum) || minimum < 1 || maximum < minimum) {
      throw new Error('Adaptive task-pool bounds are invalid.');
    }
  }

  get activeCount(): number { return this.active; }
  get queuedCount(): number { return this.queue.length; }

  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ task, resolve, reject } as QueuedTask<unknown>);
      this.drain();
    });
  }

  private drain(): void {
    while (this.queue.length) {
      const target = adaptiveConcurrency(this.active + this.queue.length, this.minimum, this.maximum);
      if (this.active >= target) return;
      const queued = this.queue.shift()!;
      this.active++;
      void Promise.resolve().then(queued.task).then(queued.resolve, queued.reject).finally(() => {
        this.active--;
        this.drain();
      });
    }
  }
}

export async function mapConcurrent<T, R>(items: readonly T[], concurrency: number,
  mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(items.length, Math.max(1, Math.floor(concurrency))) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
