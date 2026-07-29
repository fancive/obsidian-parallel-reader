'use strict';

import type { ErrorKind, GenerationPhase } from './types';

export class GenerationJobAlreadyRunningError extends Error {
  code: string;
  key: string;

  constructor(key: string) {
    super('already-running');
    this.name = 'GenerationJobAlreadyRunningError';
    this.code = 'already-running';
    this.key = key;
  }
}

export class GenerationJobCancelledError extends Error {
  code: string;
  key: string;

  constructor(key: string) {
    super('cancelled');
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
      } catch (e: unknown) {
        console.warn('[parallel-reader] cancel handler error', e);
      }
    }
    return true;
  }

  throwIfCancelled(): void {
    if (this.cancelled) throw new GenerationJobCancelledError(this.key);
  }
}

type Waiter = { key: string; resolve: () => void; reject: (err: Error) => void };

export class GenerationJobManager {
  private jobs: Map<string, GenerationJob>;
  private waiters: Waiter[] = [];
  /**
   * Live count of slots in use OR resolved-but-not-yet-set. This is the
   * authoritative concurrency gauge — using `jobs.size` alone has a race
   * window between `releaseSlot.resolve()` and the awaiter's `jobs.set()`
   * during which a fresh `start()` could see a free slot and double-book.
   */
  private reserved = 0;
  /**
   * Declared as a plain field rather than a `constructor(private maxConcurrent…)`
   * parameter property: parameter properties are *not* erasable syntax, so Node's
   * native type stripping rejects them, and the coverage harness loads these
   * sources directly as `.ts` (see tests/ts-loader.js).
   */
  private maxConcurrent: number;

  constructor(maxConcurrent = 3) {
    this.maxConcurrent = maxConcurrent;
    this.jobs = new Map();
  }

  get(key: string): GenerationJob | null {
    return this.jobs.get(key) || null;
  }

  isRunning(key: string): boolean {
    return this.jobs.has(key);
  }

  /** Returns true if a key is either running or queued. */
  isPending(key: string): boolean {
    return this.jobs.has(key) || this.waiters.some((w) => w.key === key);
  }

  waitingCount(): number {
    return this.waiters.length;
  }

  /**
   * Reject all queued waiters with cancellation. Used on plugin unload or batch cancel
   * so queued promises don't leak. Does not affect `reserved` — queued waiters were
   * not yet counted toward `reserved` (they get incremented on resolve).
   */
  cancelAllWaiters(): number {
    const drained = this.waiters.splice(0);
    for (const w of drained) w.reject(new GenerationJobCancelledError(w.key));
    return drained.length;
  }

  /**
   * Returns null if a slot is immediately available (and reserves it synchronously,
   * so the caller can take the fast path). Returns a Promise when queueing is required.
   */
  private waitSlot(key: string): Promise<void> | null {
    if (this.reserved < this.maxConcurrent) {
      this.reserved++;
      return null;
    }
    return new Promise<void>((resolve, reject) => {
      // Wrap resolve so the slot is reserved synchronously inside releaseSlot()
      // before any other start() can read `reserved`.
      this.waiters.push({
        key,
        resolve: () => {
          this.reserved++;
          resolve();
        },
        reject,
      });
    });
  }

  private releaseSlot(): void {
    this.reserved--;
    const next = this.waiters.shift();
    if (next) next.resolve(); // wrapped resolve increments `reserved` synchronously
  }

  async start<T>(key: string, runner: (job: GenerationJob) => Promise<T>): Promise<T> {
    // Reject same-key dedup at entry (running OR queued).
    if (this.isPending(key)) throw new GenerationJobAlreadyRunningError(key);
    const wait = this.waitSlot(key);
    if (wait) {
      // If cancelled while queued (cancelAllWaiters), the slot was never reserved
      // for this caller, so no releaseSlot is needed — propagation is enough.
      await wait;
      if (this.jobs.has(key)) {
        // Same-key racily inserted while we waited; release the slot we got.
        this.reserved--;
        const next = this.waiters.shift();
        if (next) next.resolve();
        throw new GenerationJobAlreadyRunningError(key);
      }
    }
    const job = new GenerationJob(key);
    this.jobs.set(key, job);
    try {
      job.setPhase('running');
      const result = await runner(job);
      job.throwIfCancelled();
      return result;
    } catch (err: unknown) {
      if (job.cancelled && !(err instanceof GenerationJobCancelledError)) {
        throw new GenerationJobCancelledError(key);
      }
      throw err;
    } finally {
      this.jobs.delete(key);
      this.releaseSlot();
    }
  }

  cancel(key: string): boolean {
    const job = this.jobs.get(key);
    if (!job) return false;
    return job.cancel();
  }

  /**
   * Cancel every in-flight job — firing each job's cancel handlers, which abort the
   * streaming HTTP request and SIGKILL any CLI child process — and reject all queued
   * waiters. Used on plugin unload so nothing keeps running after teardown. Returns
   * the total number of jobs and waiters cancelled.
   */
  cancelAll(): number {
    let cancelled = 0;
    for (const job of this.jobs.values()) {
      if (job.cancel()) cancelled++;
    }
    return cancelled + this.cancelAllWaiters();
  }
}

export function classifyGenerationError(error: unknown): ErrorKind {
  if (error instanceof GenerationJobCancelledError) return 'cancelled';
  const errObj = error as { code?: string; message?: string } | null;
  if (errObj?.code === 'cancelled') return 'cancelled';

  // Structured CLI error short-circuits message-regex matching for the deterministic cases.
  // Duck-typed to avoid circular import with ./cli.
  const details = (error as { details?: { reason?: string } } | null)?.details;
  if (details && typeof details.reason === 'string') {
    switch (details.reason) {
      case 'wall-timeout':
        return 'timeout';
      case 'spawn-failure':
      case 'startup-error':
        return 'config';
      case 'streams-unavailable':
        return 'unknown';
      // exit-nonzero falls through: stderr might carry auth/rate-limit/schema info.
    }
  }

  const message = String(errObj?.message || error);
  if (/api key|unauthorized|401|403|认证|权限/i.test(message)) return 'auth';
  if (/timeout|超时|timed out/i.test(message)) return 'timeout';
  if (/429|rate limit|too many requests/i.test(message)) return 'rate-limit';
  if (
    /ECONNREFUSED|ENOTFOUND|ENETUNREACH|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|Failed to fetch|NetworkError|net::ERR_|fetch failed/i.test(
      message,
    )
  )
    return 'network';
  if (
    /非 JSON|非预期输出|没有返回结果|non-JSON|unexpected output|no result|json_schema|schema|structured/i.test(message)
  )
    return 'schema';
  if (/model 未设置|base url|配置|config/i.test(message)) return 'config';
  return 'unknown';
}
