'use strict';

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

export type ErrorKind =
  | 'auth'
  | 'timeout'
  | 'rate-limit'
  | 'schema'
  | 'config'
  | 'cancelled'
  | 'unknown';

/* ---------- Prompt types ---------- */

export interface PromptPair {
  system: string;
  user: string;
}
