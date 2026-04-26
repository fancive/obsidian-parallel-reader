'use strict';

import type { App } from 'obsidian';

export function normalizeVaultPath(path: string): string {
  return String(path || '')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => !!part && part !== '..' && part !== '.')
    .join('/');
}

export function folderPathsForTarget(folderPath: string): string[] {
  const normalized = normalizeVaultPath(folderPath);
  if (!normalized) return [];
  const parts = normalized.split('/');
  return parts.map((_, idx) => parts.slice(0, idx + 1).join('/'));
}

export async function ensureVaultFolder(app: App, folderPath: string) {
  for (const folder of folderPathsForTarget(folderPath)) {
    if (app.vault.getAbstractFileByPath(folder)) continue;
    try {
      await app.vault.createFolder(folder);
    } catch (e) {
      if (!app.vault.getAbstractFileByPath(folder)) throw e;
    }
  }
}
