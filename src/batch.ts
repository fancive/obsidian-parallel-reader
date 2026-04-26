'use strict';

import { cacheEntryMatches } from './settings';
import type { CacheEntry, PluginSettings } from './types';

export interface BatchFileLike {
  path: string;
  parent?: { path: string } | null;
}

export interface BatchStats {
  total: number;
  skipped: number;
}

export function normalizeBatchFolderInput(input: string): string {
  return (input || '')
    .trim()
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
}

export function isFileInBatchFolder(file: BatchFileLike, folderPath: string): boolean {
  if (!folderPath) return !file.path.includes('/');
  return file.parent?.path === folderPath;
}

export function selectBatchFiles<T extends BatchFileLike>(files: T[], folderPath: string): T[] {
  const normalized = normalizeBatchFolderInput(folderPath);
  return files.filter((file) => isFileInBatchFolder(file, normalized));
}

export function batchProgressVars(index: number, total: number): { current: number; total: number } {
  return { current: index + 1, total };
}

export function createBatchStats(total: number): BatchStats {
  return { total, skipped: 0 };
}

export function recordBatchSkip(stats: BatchStats): BatchStats {
  return { ...stats, skipped: stats.skipped + 1 };
}

export function shouldSkipBatchFile(entry: CacheEntry | null, content: string, settings: PluginSettings): boolean {
  return !!entry && cacheEntryMatches(entry, content, settings);
}
