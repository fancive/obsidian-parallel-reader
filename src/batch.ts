'use strict';

import { type App, Modal } from 'obsidian';
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
  errors: number;
}

export interface BatchRunState {
  cancelled: boolean;
  currentPath: string;
}

export type BatchFolderValidationReason = 'ok' | 'unsafe' | 'missing';

export interface BatchFolderValidation {
  valid: boolean;
  reason: BatchFolderValidationReason;
  folderPath: string;
}

export function normalizeBatchFolderInput(input: string): string {
  return (input || '')
    .trim()
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
}

export function hasUnsafeBatchFolderSegments(input: string): boolean {
  return (input || '')
    .split('/')
    .map((part) => part.trim())
    .some((part) => part === '.' || part === '..');
}

export function validateBatchFolderInput(
  input: string,
  folderExists: (folderPath: string) => boolean,
): BatchFolderValidation {
  const folderPath = normalizeBatchFolderInput(input);
  if (hasUnsafeBatchFolderSegments(input)) return { valid: false, reason: 'unsafe', folderPath };
  if (folderPath && !folderExists(folderPath)) return { valid: false, reason: 'missing', folderPath };
  return { valid: true, reason: 'ok', folderPath };
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
  return { total, processed: 0, skipped: 0, errors: 0 };
}

export function recordBatchProcessed(stats: BatchStats): BatchStats {
  return { ...stats, processed: stats.processed + 1 };
}

export function recordBatchSkip(stats: BatchStats): BatchStats {
  return { ...stats, processed: stats.processed + 1, skipped: stats.skipped + 1 };
}

export function recordBatchError(stats: BatchStats): BatchStats {
  return { ...stats, processed: stats.processed + 1, errors: stats.errors + 1 };
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

export function promptForBatchFolder(app: App, selectText: string, promptText: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const modal = new Modal(app);
    modal.onOpen = () => {
      modal.contentEl.createEl('p', { text: selectText });
      const field = modal.contentEl.createDiv({ cls: 'parallel-reader-modal-field' });
      const input = field.createEl('input', { type: 'text' });
      input.placeholder = promptText;
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          resolve(input.value.trim());
          modal.close();
        }
      });
      modal.contentEl.createEl('button', { text: 'OK' }).addEventListener('click', () => {
        resolve(input.value.trim());
        modal.close();
      });
    };
    modal.onClose = () => resolve(null);
    modal.open();
  });
}
