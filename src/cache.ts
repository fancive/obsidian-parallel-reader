'use strict';

export function touchCacheEntry(entry, now?) {
  if (!entry) return null;
  entry.lastAccessedAt = now || new Date().toISOString();
  return entry;
}

export function serializeCacheFile(entries) {
  return JSON.stringify({
    version: 1,
    entries: entries || {},
  });
}

export function shouldConfirmRegenerate(entry, force) {
  return !!force && !!entry && typeof entry.updatedAt === 'string' && entry.updatedAt.trim().length > 0;
}
