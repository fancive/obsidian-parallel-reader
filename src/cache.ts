'use strict';

import type { CacheEntry } from './types';

export function touchCacheEntry(entry: CacheEntry | null, now?: string): CacheEntry | null {
  if (!entry) return null;
  entry.lastAccessedAt = now || new Date().toISOString();
  return entry;
}

export function serializeCacheFile(entries: Record<string, CacheEntry>): string {
  return JSON.stringify({
    version: 1,
    entries: entries || {},
  });
}

export function shouldConfirmRegenerate(entry: CacheEntry | null, force: boolean): boolean {
  return !!force && !!entry && typeof entry.updatedAt === 'string' && entry.updatedAt.trim().length > 0;
}
