'use strict';

import type { DataAdapter } from 'obsidian';
import { serializeCacheFile, touchCacheEntry } from './cache';
import {
  CACHE_SCHEMA_VERSION,
  DEFAULT_MAX_CACHE_ENTRIES,
  generationFingerprint,
  hashContent,
  pruneCacheEntries,
} from './settings';
import type { CacheEntry, PluginSettings, RawCard, ResolvedCard } from './types';

/**
 * Reject cache entries whose shape would crash downstream consumers (e.g. cards.map).
 * Missing optional fields like contentHash/settingsHash are tolerated — they just
 * cause a normal cache miss instead of returning stale data.
 */
function isValidCacheEntry(entry: unknown): entry is CacheEntry {
  if (!entry || typeof entry !== 'object') return false;
  const cards = (entry as { cards?: unknown }).cards;
  if (!Array.isArray(cards)) return false;
  for (const c of cards) {
    if (!c || typeof c !== 'object') return false;
    const card = c as { bullets?: unknown; anchor?: unknown };
    // bullets is allowed to be missing (defaults to []), but if present must be an array
    if (card.bullets !== undefined && !Array.isArray(card.bullets)) return false;
    // anchor is allowed to be missing, but if present must be a string
    // (downstream resolveCardAnchors / findLineForAnchor expects string)
    if (card.anchor !== undefined && typeof card.anchor !== 'string') return false;
  }
  return true;
}

export class CacheManager {
  cache: Record<string, CacheEntry> = {};
  private _timer: number | null = null;
  private _dirty = false;
  /**
   * Tail of the cache transaction queue. Every mutation and every write runs through
   * `runExclusive`, so a "mutate `this.cache` then persist it" pair is atomic with
   * respect to all other cache work. See `runExclusive` for why that matters.
   *
   * Invariant: the tail NEVER rejects — `runExclusive` re-publishes it with the error
   * swallowed, so one failed transaction cannot poison every transaction behind it.
   * Each caller still receives its own rejection through the promise it awaits.
   */
  private _txTail: Promise<void> = Promise.resolve();

  // Declared as plain fields rather than `constructor(private readonly adapter…)`
  // parameter properties: parameter properties are not erasable syntax, so Node's
  // native type stripping rejects them, and the coverage harness loads these
  // sources directly as `.ts` (see tests/ts-loader.js).
  private readonly adapter: DataAdapter;
  private readonly configDir: string;
  private readonly pluginId: string;
  private readonly getSettings: () => PluginSettings;

  constructor(adapter: DataAdapter, configDir: string, pluginId: string, getSettings: () => PluginSettings) {
    this.adapter = adapter;
    this.configDir = configDir;
    this.pluginId = pluginId;
    this.getSettings = getSettings;
  }

  filePath(): string {
    return `${this.configDir}/plugins/${this.pluginId}/cache.json`;
  }

  async ensureDir(): Promise<void> {
    const dir = `${this.configDir}/plugins/${this.pluginId}`;
    try {
      if (typeof this.adapter.exists === 'function' && (await this.adapter.exists(dir))) return;
      await this.adapter.mkdir(dir);
    } catch {
      /* ignore race */
    }
  }

  async readFile(): Promise<Record<string, CacheEntry>> {
    try {
      const raw = await this.adapter.read(this.filePath());
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
        const validated: Record<string, CacheEntry> = {};
        let dropped = 0;
        for (const [path, entry] of Object.entries(parsed.entries as Record<string, unknown>)) {
          if (isValidCacheEntry(entry)) validated[path] = entry;
          else dropped++;
        }
        if (dropped > 0) console.warn('[parallel-reader] dropped', dropped, 'malformed cache entries');
        return validated;
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      if (!/not found|does not exist|ENOENT/i.test(message))
        console.warn('[parallel-reader] failed to read cache.json', e);
    }
    return {};
  }

  async writeFile(): Promise<void> {
    await this.ensureDir();
    await this.adapter.write(this.filePath(), serializeCacheFile(this.cache));
  }

  /**
   * Run `body` as an exclusive cache transaction: it starts only once every transaction
   * queued before it has settled, and nothing else touches the cache while it runs.
   *
   * This is what makes a mutation and the write that commits it atomic. Without it,
   * `put(A)` and `put(B)` — which batch generation really does issue concurrently, the
   * job manager runs 3 at a time — interleave: B's write can land while A's is still in
   * flight, and A's failure handler then has to undo a cache that no longer reflects
   * only A's edit. (The previous whole-object snapshot restore got exactly that wrong:
   * rolling A back erased B's committed entry too.) Serializing also stops one
   * transaction's payload from carrying another's uncommitted mutation to disk.
   *
   * Deadlock safety: transaction bodies may only call the lock-free internals
   * (`writeNow`/`commit`/`writeFile`/`prune`/`readFile`) — never the public `save`,
   * `flush`, or any mutator, all of which take the lock themselves. Re-entering the
   * queue from inside a transaction would wait on a link that cannot start until the
   * caller returns.
   *
   * Queue growth is bounded by the number of in-flight callers: each link is dropped as
   * soon as it settles, since the tail is reassigned rather than accumulated.
   */
  private runExclusive<T>(body: () => Promise<T>): Promise<T> {
    const run = this._txTail.then(body);
    this._txTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async load(): Promise<void> {
    await this.runExclusive(async () => {
      this.cache = await this.readFile();
      const pruned = this.prune();
      if (pruned.length > 0) await this.writeFile();
    });
  }

  prune(): string[] {
    const settings = this.getSettings();
    return pruneCacheEntries(this.cache, settings?.maxCacheEntries || DEFAULT_MAX_CACHE_ENTRIES);
  }

  async pruneIfNeeded(): Promise<string[]> {
    return this.runExclusive(async () => {
      const removed = this.prune();
      if (removed.length > 0) await this.writeNow();
      return removed;
    });
  }

  private clearTimer(): void {
    if (this._timer) {
      activeWindow.clearTimeout(this._timer);
      this._timer = null;
    }
  }

  async save(): Promise<void> {
    // Cancel the debounce up front (not inside the transaction) so a save requested now
    // cannot be followed by a stale timer firing while it waits its turn in the queue.
    this.clearTimer();
    await this.runExclusive(() => this.writeNow());
  }

  /**
   * The actual write. Lock-free: callable only from inside a transaction.
   */
  private async writeNow(): Promise<void> {
    this.clearTimer();
    this.prune();
    // Clear the dirty flag BEFORE awaiting, not after: writeFile() serializes the cache
    // synchronously, so a mutation arriving while the write is in flight is not in that
    // payload and must leave the cache dirty. Clearing afterwards swallowed it — the
    // already-scheduled debounce timer would then see `_dirty === false` and skip.
    this._dirty = false;
    try {
      await this.writeFile();
    } catch (e: unknown) {
      this._dirty = true;
      throw e;
    }
  }

  /**
   * Persist the mutation the calling transaction just made, undoing it via `rollback` if
   * the adapter write rejects.
   *
   * Every mutator below edits `this.cache` and then awaits the write. Without this
   * rollback a rejected write left the edit in memory while the caller (and the UI)
   * reported failure: reopening the note applied the "failed" change, and the next
   * successful write — a debounced touch, say — flushed it to disk. The in-memory cache
   * must never claim more than the disk actually accepted.
   *
   * `rollback` must restore only the keys ITS OWN transaction touched. Restoring a
   * snapshot of the whole cache is wrong even under serialization: entries committed by
   * earlier transactions are not this transaction's to undo. (A rejected write does keep
   * any `prune()` eviction made by the same transaction — memory then claims *less* than
   * disk, which is safe: the pruned entries were slated for deletion anyway.)
   *
   * Lock-free: callable only from inside a transaction.
   */
  private async commit(rollback: () => void): Promise<void> {
    try {
      await this.writeNow();
    } catch (e: unknown) {
      rollback();
      throw e;
    }
  }

  scheduleSave(delayMs = 5000): void {
    this._dirty = true;
    if (this._timer) return;
    this._timer = activeWindow.setTimeout(() => {
      this._timer = null;
      if (!this._dirty) return;
      this.save().catch((e: unknown) => console.error('[parallel-reader] failed to save cache', e));
    }, delayMs);
  }

  async flush(): Promise<void> {
    this.clearTimer();
    // A debounce whose timer already fired leaves no timer to find, but its write can
    // still be in flight — and other transactions may be queued behind it. Queue behind
    // the whole tail instead of racing a second concurrent write past it (cf.
    // flushSettingsSave in main.ts, which had the same blind spot).
    //
    // The dirty check runs INSIDE the transaction, i.e. after everything queued ahead
    // has settled: if those writes persisted the pending state there is nothing left to
    // do, and if one of them failed it restored `_dirty` and this retries it.
    await this.runExclusive(async () => {
      if (!this._dirty) return;
      await this.writeNow();
    });
  }

  get(filePath: string): CacheEntry | null {
    return this.cache[filePath] || null;
  }

  touch(filePath: string): CacheEntry | null {
    const entry = touchCacheEntry(this.cache[filePath] || null);
    if (!entry) return null;
    this.cache[filePath] = entry;
    this.scheduleSave();
    return entry;
  }

  async move(oldPath: string, newPath: string): Promise<boolean> {
    if (typeof oldPath !== 'string' || typeof newPath !== 'string') return false;
    if (!oldPath.trim() || !newPath.trim()) return false;
    // The existence checks belong inside the transaction: read them here and a mutation
    // queued ahead of us could invalidate them before our own edit lands.
    return this.runExclusive(async () => {
      if (oldPath === newPath) return Object.hasOwn(this.cache, oldPath);
      const entry = this.cache[oldPath];
      if (!entry) return false;
      if (Object.hasOwn(this.cache, newPath)) return false;

      this.cache[newPath] = entry;
      delete this.cache[oldPath];
      await this.commit(() => {
        this.cache[oldPath] = entry;
        delete this.cache[newPath];
      });
      return true;
    });
  }

  async put(filePath: string, content: string, cards: RawCard[], settings: PluginSettings): Promise<void> {
    await this.runExclusive(async () => {
      const had = Object.hasOwn(this.cache, filePath);
      const previous = this.cache[filePath];
      const now = new Date().toISOString();
      this.cache[filePath] = {
        schemaVersion: CACHE_SCHEMA_VERSION,
        contentHash: hashContent(content),
        settingsHash: generationFingerprint(settings || this.getSettings()),
        cards,
        generatedAt: now,
        lastAccessedAt: now,
      };
      await this.commit(() => {
        if (had) this.cache[filePath] = previous;
        else delete this.cache[filePath];
      });
    });
  }

  async replaceCards(filePath: string, cards: ResolvedCard[]): Promise<boolean> {
    return this.runExclusive(async () => {
      const entry = this.cache[filePath];
      if (!entry) return false;
      const now = new Date().toISOString();
      this.cache[filePath] = {
        ...entry,
        cards: (cards || []).map((card: ResolvedCard) => ({
          title: card.title,
          anchor: card.anchor,
          gist: card.gist,
          bullets: card.bullets || [],
        })),
        updatedAt: now,
        lastAccessedAt: now,
      };
      await this.commit(() => {
        this.cache[filePath] = entry;
      });
      return true;
    });
  }

  async delete(filePath: string): Promise<void> {
    await this.runExclusive(async () => {
      const previous = this.cache[filePath];
      if (!previous) return;
      delete this.cache[filePath];
      await this.commit(() => {
        this.cache[filePath] = previous;
      });
    });
  }

  async clear(): Promise<void> {
    await this.runExclusive(async () => {
      // clear() owns every key, so a whole-cache snapshot IS this transaction's own
      // state here — and serialization guarantees no other mutation slipped in between
      // the emptying and the write. Entries are removed in place (rather than swapping
      // in a fresh object) so `this.cache`'s identity stays stable for the lifetime of
      // the manager.
      const previous = { ...this.cache };
      for (const key of Object.keys(this.cache)) delete this.cache[key];
      await this.commit(() => {
        Object.assign(this.cache, previous);
      });
    });
  }
}
