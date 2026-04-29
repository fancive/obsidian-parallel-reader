'use strict';

import crypto from 'crypto';
import { translate } from './i18n';
import { API_PROVIDER_PRESETS } from './provider-presets';
import type { ApiFormat, ApiProviderPreset, CacheEntry, PluginSettings } from './types';

export { API_PROVIDER_PRESETS } from './provider-presets';

export const MAX_DOC_CHARS = 100000;
export const PROMPT_VERSION = 2;
export const CACHE_SCHEMA_VERSION = 2;
export const DEFAULT_MAX_CACHE_ENTRIES = 100;
export const MIN_STREAMING_TIMEOUT_MS = 1000;
export const PROMPT_LANGUAGES = {
  zh: '中文',
  en: 'English',
  auto: 'Auto-detect',
};
export const UI_LANGUAGES = {
  auto: 'Auto',
  zh: '中文',
  en: 'English',
};

export const DEFAULT_SETTINGS: PluginSettings = {
  uiLanguage: 'auto',
  backend: 'api',
  cliPath: '',
  apiProvider: 'anthropic',
  apiFormat: 'anthropic-messages',
  apiBaseUrl: '',
  apiKey: '',
  apiKeyEnvVar: '',
  apiAuthType: 'auto',
  apiHeaders: '',
  apiMaxTokens: 4096,
  maxDocChars: MAX_DOC_CHARS,
  maxCacheEntries: DEFAULT_MAX_CACHE_ENTRIES,
  promptLanguage: 'zh',
  minCards: 5,
  maxCards: 15,
  customSystemPrompt: '',
  model: 'claude-sonnet-4-6',
  exportFolder: 'Reading/Articles',
  cliTimeoutMs: 120000,
  streaming: true,
  streamingTimeoutMs: 120000,
};

export const API_FORMATS: Record<string, ApiFormat> = {
  'anthropic-messages': {
    label: 'Anthropic Messages',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    defaultAuthType: 'x-api-key',
  },
  'openai-chat': {
    label: 'OpenAI Chat Completions',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultAuthType: 'bearer',
    tokenLimitField: 'max_tokens',
  },
  'openai-responses': {
    label: 'OpenAI Responses',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultAuthType: 'bearer',
  },
  'google-generative-ai': {
    label: 'Google Gemini generateContent',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultAuthType: 'x-goog-api-key',
  },
};

export const API_AUTH_TYPES = {
  auto: 'Auto',
  bearer: 'Authorization: Bearer',
  'x-api-key': 'x-api-key',
  'x-goog-api-key': 'x-goog-api-key',
  'api-key': 'api-key',
  none: 'None',
};

export function hashContent(text: string): string {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex');
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + stableStringify((value as Record<string, unknown>)[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}

export function isApiBackend(backend: string): boolean {
  return backend === 'api' || backend === 'anthropic-api';
}

export function getApiPreset(settings: PluginSettings): ApiProviderPreset {
  return API_PROVIDER_PRESETS[settings.apiProvider] || API_PROVIDER_PRESETS.anthropic;
}

export function getApiFormat(settings: PluginSettings): string {
  const preset = getApiPreset(settings);
  const format = (settings.apiFormat || preset.format || '').trim();
  return API_FORMATS[format] ? format : preset.format;
}

export function getApiBaseUrl(settings: PluginSettings): string {
  const format = getApiFormat(settings);
  const preset = getApiPreset(settings);
  const explicit = (settings.apiBaseUrl || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  if ((settings.apiProvider || '').startsWith('custom-')) {
    throw new Error(translate(settings, 'errorCustomProviderBaseUrlRequired'));
  }
  const base = (preset.baseUrl || API_FORMATS[format].defaultBaseUrl || '').trim();
  if (!base) {
    throw new Error(translate(settings, 'errorApiBaseUrlMissing'));
  }
  return base.replace(/\/+$/, '');
}

export function getApiAuthType(settings: PluginSettings): string {
  const configured = (settings.apiAuthType || 'auto').trim();
  if (configured && configured !== 'auto') return configured;
  const preset = getApiPreset(settings);
  const format = getApiFormat(settings);
  return preset.authType || API_FORMATS[format].defaultAuthType || 'bearer';
}

export function getApiKey(settings: PluginSettings): string {
  const direct = (settings.apiKey || '').trim();
  if (direct) return direct;
  const envVar = (settings.apiKeyEnvVar || getApiPreset(settings).envVar || '').trim();
  if (envVar && process.env?.[envVar]) {
    return String(process.env[envVar]).trim();
  }
  return '';
}

export function modelForApi(settings: PluginSettings): string {
  const raw = (settings.model || '').trim();
  if (!raw) {
    throw new Error(translate(settings, 'errorModelMissing'));
  }
  const preset = getApiPreset(settings);
  const prefixes = [settings.apiProvider, preset.modelPrefix].map((p) => (p || '').trim()).filter(Boolean);
  const lowerRaw = raw.toLowerCase();
  for (const provider of prefixes) {
    const normalized = provider.toLowerCase();
    if (lowerRaw.startsWith(normalized + '/')) {
      return raw.slice(provider.length + 1).trim();
    }
  }
  return raw;
}

export function applyApiProviderPreset(settings: Readonly<PluginSettings>, providerId: string): PluginSettings {
  const previousPreset = getApiPreset(settings);
  const preset = API_PROVIDER_PRESETS[providerId] || API_PROVIDER_PRESETS.anthropic;
  const previousModel = (settings.model || '').trim();
  const shouldSwapModel =
    !previousModel ||
    previousModel === DEFAULT_SETTINGS.model ||
    (!!previousPreset.model && previousModel === previousPreset.model);

  return {
    ...settings,
    apiProvider: providerId,
    apiFormat: preset.format,
    apiBaseUrl: preset.baseUrl,
    apiAuthType: preset.authType || 'auto',
    apiKeyEnvVar: preset.envVar || '',
    ...(shouldSwapModel ? { model: preset.model || '' } : {}),
  };
}

export function normalizeSettings(settings: Readonly<PluginSettings>): PluginSettings {
  const out: PluginSettings = { ...settings };
  if (!(UI_LANGUAGES as Record<string, string>)[out.uiLanguage]) out.uiLanguage = DEFAULT_SETTINGS.uiLanguage;
  if (!out.apiProvider || !API_PROVIDER_PRESETS[out.apiProvider]) {
    out.apiProvider = 'anthropic';
  }
  const preset = getApiPreset(out);
  if (!out.apiFormat || !API_FORMATS[out.apiFormat]) out.apiFormat = preset.format;
  if (!out.apiAuthType || !(API_AUTH_TYPES as Record<string, string>)[out.apiAuthType]) out.apiAuthType = 'auto';
  const rawBackend = out.backend as string;
  if (rawBackend === 'anthropic-api') {
    out.backend = 'api';
    out.apiProvider = out.apiProvider || 'anthropic';
    out.apiFormat = out.apiFormat || 'anthropic-messages';
    out.apiBaseUrl = out.apiBaseUrl || API_PROVIDER_PRESETS.anthropic.baseUrl;
    out.apiAuthType = out.apiAuthType || 'x-api-key';
    out.apiKeyEnvVar = out.apiKeyEnvVar || 'ANTHROPIC_API_KEY';
  } else if (!(['api', 'claude-code', 'codex'] as string[]).includes(rawBackend)) {
    out.backend = DEFAULT_SETTINGS.backend;
  }
  const n = Number(out.apiMaxTokens);
  if (!Number.isFinite(n) || n <= 0) out.apiMaxTokens = DEFAULT_SETTINGS.apiMaxTokens;
  const maxDocChars = Number(out.maxDocChars);
  if (!Number.isFinite(maxDocChars) || maxDocChars < 1000) out.maxDocChars = DEFAULT_SETTINGS.maxDocChars;
  out.maxCacheEntries = normalizeMaxCacheEntries(out.maxCacheEntries);
  if (!(PROMPT_LANGUAGES as Record<string, string>)[out.promptLanguage])
    out.promptLanguage = DEFAULT_SETTINGS.promptLanguage;
  out.minCards = normalizeCardCount(out.minCards, DEFAULT_SETTINGS.minCards);
  out.maxCards = normalizeCardCount(out.maxCards, DEFAULT_SETTINGS.maxCards);
  if (out.maxCards < out.minCards) out.maxCards = out.minCards;
  out.streamingTimeoutMs = normalizeStreamingTimeoutMs(out.streamingTimeoutMs);
  if (typeof out.customSystemPrompt !== 'string') out.customSystemPrompt = '';
  return out;
}

export function normalizeCardCount(value: unknown, fallback: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(30, Math.max(1, n));
}

export function normalizeMaxCacheEntries(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_CACHE_ENTRIES;
  return n;
}

export function normalizeStreamingTimeoutMs(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < MIN_STREAMING_TIMEOUT_MS) return DEFAULT_SETTINGS.streamingTimeoutMs;
  return n;
}

function cacheEntryTime(entry: CacheEntry): number {
  const value = entry && (entry.lastAccessedAt || entry.generatedAt || entry.updatedAt);
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function pruneCacheEntries(cache: Record<string, CacheEntry>, maxEntries: number): string[] {
  if (!cache || typeof cache !== 'object') return [];
  const max = normalizeMaxCacheEntries(maxEntries);
  const entries = Object.entries(cache);
  if (entries.length <= max) return [];

  const removed = entries
    .sort(([pathA, entryA], [pathB, entryB]) => {
      const delta = cacheEntryTime(entryA) - cacheEntryTime(entryB);
      return delta || pathA.localeCompare(pathB);
    })
    .slice(0, entries.length - max)
    .map(([filePath]) => filePath);

  for (const filePath of removed) delete cache[filePath];
  return removed;
}

export function generationFingerprint(settings: PluginSettings): string {
  const normalized = normalizeSettings(Object.assign({}, DEFAULT_SETTINGS, settings || {}));
  const apiBackend = isApiBackend(normalized.backend);
  const preset = getApiPreset(normalized);
  const format = getApiFormat(normalized);
  const apiBaseUrl = apiBackend
    ? (normalized.apiBaseUrl || preset.baseUrl || API_FORMATS[format]?.defaultBaseUrl || '').trim().replace(/\/+$/, '')
    : '';
  return hashContent(
    stableStringify({
      cacheSchemaVersion: CACHE_SCHEMA_VERSION,
      promptVersion: PROMPT_VERSION,
      maxDocChars: Number(normalized.maxDocChars) || DEFAULT_SETTINGS.maxDocChars,
      promptLanguage: normalized.promptLanguage,
      minCards: normalized.minCards,
      maxCards: normalized.maxCards,
      customSystemPromptHash: hashContent(normalized.customSystemPrompt || ''),
      backend: normalized.backend,
      model: normalized.model,
      apiProvider: apiBackend ? normalized.apiProvider : '',
      apiFormat: apiBackend ? format : '',
      apiBaseUrl,
      apiAuthType: apiBackend ? getApiAuthType(normalized) : '',
      apiHeadersHash: apiBackend ? hashContent(normalized.apiHeaders || '') : '',
      apiMaxTokens: apiBackend ? Number(normalized.apiMaxTokens) || DEFAULT_SETTINGS.apiMaxTokens : 0,
      structuredOutputVersion: 1,
    }),
  );
}

export function cacheEntryMatches(entry: CacheEntry | null, content: string, settings: PluginSettings): boolean {
  return (
    !!entry &&
    entry.schemaVersion === CACHE_SCHEMA_VERSION &&
    entry.contentHash === hashContent(content) &&
    entry.settingsHash === generationFingerprint(settings)
  );
}
