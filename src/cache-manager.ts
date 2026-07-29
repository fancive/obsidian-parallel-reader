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
  private _saving: Promise<void> | null = null;

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

  async load(): Promise<void> {
    this.cache = await this.readFile();
    const pruned = this.prune();
    if (pruned.length > 0) await this.writeFile();
  }

  prune(): string[] {
    const settings = this.getSettings();
    return pruneCacheEntries(this.cache, settings?.maxCacheEntries || DEFAULT_MAX_CACHE_ENTRIES);
  }

  async pruneIfNeeded(): Promise<string[]> {
    const removed = this.prune();
    if (removed.length > 0) await this.save();
    return removed;
  }

  async save(): Promise<void> {
    if (this._timer) {
      activeWindow.clearTimeout(this._timer);
      this._timer = null;
    }
    this.prune();
    // Clear the dirty flag BEFORE awaiting, not after: writeFile() serializes the cache
    // synchronously, so a mutation arriving while the write is in flight is not in that
    // payload and must leave the cache dirty. Clearing afterwards swallowed it — the
    // already-scheduled debounce timer would then see `_dirty === false` and skip.
    this._dirty = false;
    const pending = this.writeFile();
    this._saving = pending;
    try {
      await pending;
    } catch (e: unknown) {
      this._dirty = true;
      throw e;
    } finally {
      if (this._saving === pending) this._saving = null;
    }
  }

  /**
   * Persist a mutation, restoring `previous` if the adapter write rejects.
   *
   * Every mutator below edits `this.cache` and then awaits the write. Without this
   * rollback a rejected write left the edit in memory while the caller (and the UI)
   * reported failure: reopening the note applied the "failed" change, and the next
   * successful write — a debounced touch, say — flushed it to disk. The in-memory cache
   * must never claim more than the disk actually accepted.
   *
   * A shallow copy is sufficient: entries are always replaced wholesale, never mutated
   * in place.
   */
  private async saveOrRestore(previous: Record<string, CacheEntry>): Promise<void> {
    try {
      await this.save();
    } catch (e: unknown) {
      this.cache = previous;
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
    if (this._timer) {
      activeWindow.clearTimeout(this._timer);
      this._timer = null;
    }
    // A debounce whose timer already fired leaves no timer to find, but its write can
    // still be in flight — await THAT instead of racing a second concurrent write past
    // it (cf. flushSettingsSave in main.ts, which had the same blind spot).
    if (this._saving) {
      try {
        await this._saving;
      } catch {
        /* the in-flight write failed and restored the dirty flag; the save below retries it */
      }
    }
    if (!this._dirty) return;
    await this.save();
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
    if (oldPath === newPath) return Object.hasOwn(this.cache, oldPath);
    const entry = this.cache[oldPath];
    if (!entry) return false;
    if (Object.hasOwn(this.cache, newPath)) return false;

    const previous = this.cache;
    const nextCache = {
      ...this.cache,
      [newPath]: entry,
    };
    delete nextCache[oldPath];
    this.cache = nextCache;
    await this.saveOrRestore(previous);
    return true;
  }

  async put(filePath: string, content: string, cards: RawCard[], settings: PluginSettings): Promise<void> {
    const previous = { ...this.cache };
    const now = new Date().toISOString();
    this.cache[filePath] = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      contentHash: hashContent(content),
      settingsHash: generationFingerprint(settings || this.getSettings()),
      cards,
      generatedAt: now,
      lastAccessedAt: now,
    };
    await this.saveOrRestore(previous);
  }

  async replaceCards(filePath: string, cards: ResolvedCard[]): Promise<boolean> {
    const entry = this.cache[filePath];
    if (!entry) return false;
    const previous = { ...this.cache };
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
    await this.saveOrRestore(previous);
    return true;
  }

  async delete(filePath: string): Promise<void> {
    if (this.cache[filePath]) {
      const previous = { ...this.cache };
      delete this.cache[filePath];
      await this.saveOrRestore(previous);
    }
  }

  async clear(): Promise<void> {
    const previous = this.cache;
    this.cache = {};
    await this.saveOrRestore(previous);
  }
}
