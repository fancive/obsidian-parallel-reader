'use strict';

import type { ErrorKind, GenerationPhase } from './types';

export class GenerationJobAlreadyRunningError extends Error {
  code: string;
  key: string;

  constructor(key: string) {
    super('该笔记正在生成对照笔记');
    this.name = 'GenerationJobAlreadyRunningError';
    this.code = 'already-running';
    this.key = key;
  }
}

export class GenerationJobCancelledError extends Error {
  code: string;
  key: string;

  constructor(key: string) {
    super('生成已取消');
    this.name = 'GenerationJobCancelledError';
    this.code = 'cancelled';
    this.key = key;
  }
}

export class GenerationJob {
  key: string;
  phase: GenerationPhase;
  cancelled: boolean;
  startedAt: string;
  updatedAt: string;
  private _cancelHandlers: Array<() => void>;

  constructor(key: string) {
    this.key = key;
    this.phase = 'queued';
    this.cancelled = false;
    this.startedAt = new Date().toISOString();
    this.updatedAt = this.startedAt;
    this._cancelHandlers = [];
  }

  setPhase(phase: GenerationPhase) {
    this.phase = phase;
    this.updatedAt = new Date().toISOString();
  }

  onCancel(handler: () => void) {
    if (typeof handler !== 'function') return;
    if (this.cancelled) {
      handler();
      return;
    }
    this._cancelHandlers.push(handler);
  }

  cancel(): boolean {
    if (this.cancelled) return false;
    this.cancelled = true;
    this.setPhase('cancelled');
    for (const handler of this._cancelHandlers.splice(0)) {
      try {
        handler();
      } catch (_) {}
    }
    return true;
  }

  throwIfCancelled(): void {
    if (this.cancelled) throw new GenerationJobCancelledError(this.key);
  }
}

export class GenerationJobManager {
  private jobs: Map<string, GenerationJob>;

  constructor() {
    this.jobs = new Map();
  }

  get(key: string): GenerationJob | null {
    return this.jobs.get(key) || null;
  }

  isRunning(key: string): boolean {
    return this.jobs.has(key);
  }

  async start<T>(key: string, runner: (job: GenerationJob) => Promise<T>): Promise<T> {
    if (this.jobs.has(key)) throw new GenerationJobAlreadyRunningError(key);
    const job = new GenerationJob(key);
    this.jobs.set(key, job);
    try {
      job.setPhase('running');
      const result = await runner(job);
      job.throwIfCancelled();
      return result;
    } catch (err) {
      if (job.cancelled && !(err instanceof GenerationJobCancelledError)) {
        throw new GenerationJobCancelledError(key);
      }
      throw err;
    } finally {
      this.jobs.delete(key);
    }
  }

  cancel(key: string): boolean {
    const job = this.jobs.get(key);
    if (!job) return false;
    return job.cancel();
  }
}

export function classifyGenerationError(error: unknown): ErrorKind {
  if (error instanceof GenerationJobCancelledError) return 'cancelled';
  const errObj = error as { code?: string; message?: string } | null;
  if (errObj?.code === 'cancelled') return 'cancelled';
  const message = String(errObj?.message || error);
  if (/api key|unauthorized|401|403|认证|权限/i.test(message)) return 'auth';
  if (/timeout|超时|timed out/i.test(message)) return 'timeout';
  if (/429|rate limit|too many requests/i.test(message)) return 'rate-limit';
  if (/非 JSON|json_schema|schema|structured/i.test(message)) return 'schema';
  if (/model 未设置|base url|配置|config/i.test(message)) return 'config';
  return 'unknown';
}
