'use strict';

import { cacheEntryMatches } from './settings';
import type { CacheEntry, PluginSettings } from './types';

export interface BatchFileLike {
  path: string;
  parent?: { path: string } | null;
}

export interface BatchStats {
  total: number;
  processed: number;
  skipped: number;
}

export interface BatchRunState {
  cancelled: boolean;
  currentPath: string;
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
  return { total, processed: 0, skipped: 0 };
}

export function recordBatchProcessed(stats: BatchStats): BatchStats {
  return { ...stats, processed: stats.processed + 1 };
}

export function recordBatchSkip(stats: BatchStats): BatchStats {
  return { ...stats, processed: stats.processed + 1, skipped: stats.skipped + 1 };
}

export function shouldSkipBatchFile(entry: CacheEntry | null, content: string, settings: PluginSettings): boolean {
  return !!entry && cacheEntryMatches(entry, content, settings);
}

export function createBatchRunState(): BatchRunState {
  return { cancelled: false, currentPath: '' };
}

export function markBatchFileRunning(state: BatchRunState, filePath: string): BatchRunState {
  state.currentPath = filePath;
  return state;
}

export function requestBatchCancel(state: BatchRunState | null): boolean {
  if (!state || state.cancelled) return false;
  state.cancelled = true;
  return true;
}
