'use strict';

export class GenerationJobAlreadyRunningError extends Error {
  code: string;
  key: string;

  constructor(key) {
    super('该笔记正在生成对照笔记');
    this.name = 'GenerationJobAlreadyRunningError';
    this.code = 'already-running';
    this.key = key;
  }
}

export class GenerationJobCancelledError extends Error {
  code: string;
  key: string;

  constructor(key) {
    super('生成已取消');
    this.name = 'GenerationJobCancelledError';
    this.code = 'cancelled';
    this.key = key;
  }
}

export class GenerationJob {
  key: string;
  phase: string;
  cancelled: boolean;
  startedAt: string;
  updatedAt: string;
  private _cancelHandlers: Array<() => void>;

  constructor(key) {
    this.key = key;
    this.phase = 'queued';
    this.cancelled = false;
    this.startedAt = new Date().toISOString();
    this.updatedAt = this.startedAt;
    this._cancelHandlers = [];
  }

  setPhase(phase) {
    this.phase = phase;
    this.updatedAt = new Date().toISOString();
  }

  onCancel(handler) {
    if (typeof handler !== 'function') return;
    if (this.cancelled) {
      handler();
      return;
    }
    this._cancelHandlers.push(handler);
  }

  cancel() {
    if (this.cancelled) return false;
    this.cancelled = true;
    this.setPhase('cancelled');
    for (const handler of this._cancelHandlers.splice(0)) {
      try { handler(); } catch (_) {}
    }
    return true;
  }

  throwIfCancelled() {
    if (this.cancelled) throw new GenerationJobCancelledError(this.key);
  }
}

export class GenerationJobManager {
  private jobs: Map<string, GenerationJob>;

  constructor() {
    this.jobs = new Map();
  }

  get(key) {
    return this.jobs.get(key) || null;
  }

  isRunning(key) {
    return this.jobs.has(key);
  }

  async start(key, runner) {
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

  cancel(key) {
    const job = this.jobs.get(key);
    if (!job) return false;
    return job.cancel();
  }
}

export function classifyGenerationError(error) {
  if (error instanceof GenerationJobCancelledError || error?.code === 'cancelled') return 'cancelled';
  const message = String(error && error.message ? error.message : error);
  if (/api key|unauthorized|401|403|认证|权限/i.test(message)) return 'auth';
  if (/timeout|超时|timed out/i.test(message)) return 'timeout';
  if (/429|rate limit|too many requests/i.test(message)) return 'rate-limit';
  if (/非 JSON|json_schema|schema|structured/i.test(message)) return 'schema';
  if (/model 未设置|base url|配置|config/i.test(message)) return 'config';
  return 'unknown';
}
