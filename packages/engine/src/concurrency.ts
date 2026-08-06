import pLimit, { type LimitFunction } from 'p-limit';

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

export class AdaptiveTaskPool {
  private readonly limit: LimitFunction;

  constructor(readonly minimum: number, readonly maximum: number) {
    if (!Number.isInteger(minimum) || !Number.isInteger(maximum) || minimum < 1 || maximum < minimum) {
      throw new Error('Adaptive task-pool bounds are invalid.');
    }
    this.limit = pLimit(minimum);
  }

  get activeCount(): number { return this.limit.activeCount; }
  get queuedCount(): number { return this.limit.pendingCount; }

  run<T>(task: () => Promise<T>): Promise<T> {
    const load=this.limit.activeCount+this.limit.pendingCount+1;
    this.limit.concurrency=adaptiveConcurrency(load,this.minimum,this.maximum);
    return this.limit(task).finally(()=>{
      const remaining=this.limit.activeCount+this.limit.pendingCount;
      this.limit.concurrency=remaining?adaptiveConcurrency(remaining,this.minimum,this.maximum):this.minimum;
    });
  }
}

export class KeyedTaskScheduler {
  private readonly pool: AdaptiveTaskPool;
  private readonly tails = new Map<string, Promise<void>>();

  constructor(readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Keyed task-scheduler concurrency is invalid.');
    this.pool = new AdaptiveTaskPool(concurrency, concurrency);
  }

  get activeCount(): number { return this.pool.activeCount; }
  get queuedCount(): number { return this.pool.queuedCount; }

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(key, tail);
    return previous.then(() => this.pool.run(task)).finally(() => {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
  }
}

export function aggregateOrderedProgress<Key,Phase extends string>(keys:readonly Key[],phases:readonly Phase[],
  update:(phase:Phase,current:number,total:number)=>void):{
    report(key:Key,phase:Phase,current:number,total:number):void;done(key:Key):void;
  }{
  if(!phases.length)throw new Error('Progress aggregation requires at least one phase.');
  type State={index:number;done:boolean;progress:Array<{current:number;total:number}>};
  const states=new Map<Key,State>(keys.map(key=>[key,{index:-1,done:false,
    progress:phases.map(()=>({current:0,total:0}))}]));
  const emit=()=>{
    const values=[...states.values()];if(!values.length||values.some(state=>state.index<0))return;
    const index=Math.min(...values.map(state=>state.index)),phase=phases[index]!;
    const total=values.reduce((sum,state)=>sum+state.progress[index]!.total,0);
    const current=values.reduce((sum,state)=>sum+state.progress[index]!.current,0);
    update(phase,current,total);
  };
  return {
    report(key,phase,current,total){
      const state=states.get(key),index=phases.indexOf(phase);if(!state||state.done||index<state.index||index<0)return;
      while(state.index<index){if(state.index>=0)state.progress[state.index]!.current=state.progress[state.index]!.total;state.index++;}
      const progress=state.progress[index]!,boundedTotal=Math.max(0,total,current);
      progress.total=Math.max(progress.total,boundedTotal);
      progress.current=Math.max(progress.current,Math.max(0,Math.min(current,boundedTotal)));
      emit();
    },
    done(key){
      const state=states.get(key);if(!state||state.done)return;
      if(state.index>=0)state.progress[state.index]!.current=state.progress[state.index]!.total;
      state.index=phases.length-1;state.done=true;emit();
    },
  };
}

export function mapConcurrent<T, R>(items: readonly T[], concurrency: number,
  mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const limit=pLimit(Math.max(1,Math.floor(concurrency)));
  return Promise.all(items.map((item,index)=>limit(mapper,item,index)));
}
