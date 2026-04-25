'use strict';

export function normalizeVaultPath(path) {
  return String(path || '')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('/');
}

export function folderPathsForTarget(folderPath) {
  const normalized = normalizeVaultPath(folderPath);
  if (!normalized) return [];
  const parts = normalized.split('/');
  return parts.map((_, idx) => parts.slice(0, idx + 1).join('/'));
}

export async function ensureVaultFolder(app, folderPath) {
  for (const folder of folderPathsForTarget(folderPath)) {
    if (app.vault.getAbstractFileByPath(folder)) continue;
    try {
      await app.vault.createFolder(folder);
    } catch (e) {
      if (!app.vault.getAbstractFileByPath(folder)) throw e;
    }
  }
}
