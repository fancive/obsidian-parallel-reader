'use strict';

import type { App, PluginManifest, TFile } from 'obsidian';

/* ---------- Card types ---------- */

/** Raw card as returned by the LLM and stored in cache (no computed fields). */
export interface RawCard {
  title: string;
  anchor: string;
  gist: string;
  bullets: string[];
}

/** Card with the computed startLine from anchor resolution. */
export interface ResolvedCard extends RawCard {
  level: number;
  startLine: number;
}

/** Patch payload when editing a card via the modal. */
export interface CardPatch {
  title?: string;
  gist?: string;
  bullets?: string[];
}

/* ---------- Cache types ---------- */

export interface CacheEntry {
  schemaVersion: number;
  contentHash: string;
  settingsHash: string;
  cards: RawCard[];
  generatedAt: string;
  lastAccessedAt?: string;
  updatedAt?: string;
}

export interface CacheFile {
  version: number;
  entries: Record<string, CacheEntry>;
}

/* ---------- Settings types ---------- */

export interface PluginSettings {
  uiLanguage: string;
  backend: string;
  cliPath: string;
  apiProvider: string;
  apiFormat: string;
  apiBaseUrl: string;
  apiKey: string;
  apiKeyEnvVar: string;
  apiAuthType: string;
  apiHeaders: string;
  apiMaxTokens: number;
  maxDocChars: number;
  maxCacheEntries: number;
  promptLanguage: string;
  minCards: number;
  maxCards: number;
  customSystemPrompt: string;
  model: string;
  exportFolder: string;
  cliTimeoutMs: number;
  streaming: boolean;
  streamingTimeoutMs: number;
}

/* ---------- Provider types ---------- */

export interface ApiProviderPreset {
  label: string;
  format: string;
  baseUrl: string;
  authType: string;
  envVar: string;
  model: string;
  tokenLimitField?: string;
  modelPrefix?: string;
}

export interface ApiFormat {
  label: string;
  defaultBaseUrl: string;
  defaultAuthType: string;
  tokenLimitField?: string;
}

/* ---------- Generation job types ---------- */

export type GenerationPhase =
  | 'queued'
  | 'running'
  | 'reading'
  | 'cache-check'
  | 'generating'
  | 'saving'
  | 'done'
  | 'cancelled';

export type ErrorKind = 'auth' | 'timeout' | 'rate-limit' | 'schema' | 'config' | 'cancelled' | 'unknown';

export interface RunForFileOptions {
  rethrowErrors?: boolean;
}

/* ---------- Prompt types ---------- */

export interface PromptPair {
  system: string;
  user: string;
}

/* ---------- Obsidian internal API types ---------- */

/** Minimal CodeMirror 6 EditorView shape used for scroll synchronization. */
export interface CmEditorView {
  scrollDOM: HTMLElement;
  state: {
    doc: {
      lineAt(pos: number): { number: number };
    };
  };
  posAtCoords(coords: { x: number; y: number }): number | null;
}

/** Obsidian Editor with optional CodeMirror 6 view attached at `.cm`. */
export interface ObsidianEditorWithCm {
  cm?: CmEditorView;
}

/** Minimal Obsidian MenuItem builder API used in file-menu callbacks. */
export interface ObsidianMenuItem {
  setTitle(title: string): this;
  setIcon(icon: string): this;
  onClick(callback: () => unknown): this;
}

/** Minimal Obsidian Menu API used to build context-menu entries. */
export interface ObsidianMenu {
  addSeparator(): void;
  addItem(cb: (item: ObsidianMenuItem) => void): void;
}

/* ---------- Plugin host interface ---------- */

/**
 * Minimal interface that extracted UI classes (View, Modal, SettingsTab)
 * use to call back into the plugin. Avoids circular imports between
 * main.ts and the extracted modules.
 */
export interface PluginHost {
  app: App;
  settings: PluginSettings;
  cache: Record<string, CacheEntry>;
  manifest: PluginManifest;
  t(key: string, vars?: Record<string, string | number>): string;
  isGeneratingFile(file: TFile | null): boolean;
  cancelGenerationForFile(file: TFile | null): boolean;
  runForFile(file: TFile | null, force: boolean, options?: RunForFileOptions): Promise<void>;
  copyCurrentViewMarkdown(): Promise<void>;
  scrollEditorToLine(line: number, file: TFile | null): Promise<void>;
  cacheReplaceCards(filePath: string, cards: ResolvedCard[]): Promise<boolean>;
  saveSettings(): Promise<void>;
  saveSettingsDebounced(delayMs?: number): void;
  cacheClear(): Promise<void>;
  pruneCacheIfNeeded(): Promise<string[]>;
}
