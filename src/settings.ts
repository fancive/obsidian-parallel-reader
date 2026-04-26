'use strict';

import crypto from 'crypto';
import { translate } from './i18n';
import type { ApiFormat, ApiProviderPreset, CacheEntry, PluginSettings } from './types';

export const MAX_DOC_CHARS = 100000;
export const PROMPT_VERSION = 2;
export const CACHE_SCHEMA_VERSION = 2;
export const DEFAULT_MAX_CACHE_ENTRIES = 100;
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

export const API_PROVIDER_PRESETS: Record<string, ApiProviderPreset> = {
  anthropic: {
    label: 'Anthropic',
    format: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com/v1',
    authType: 'x-api-key',
    envVar: 'ANTHROPIC_API_KEY',
    model: 'claude-sonnet-4-6',
  },
  openai: {
    label: 'OpenAI',
    format: 'openai-chat',
    baseUrl: 'https://api.openai.com/v1',
    authType: 'bearer',
    envVar: 'OPENAI_API_KEY',
    tokenLimitField: 'max_completion_tokens',
    model: 'gpt-5.1',
  },
  'openai-responses': {
    label: 'OpenAI Responses',
    format: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    authType: 'bearer',
    envVar: 'OPENAI_API_KEY',
    modelPrefix: 'openai',
    model: 'gpt-5.1',
  },
  google: {
    label: 'Google Gemini',
    format: 'google-generative-ai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    authType: 'x-goog-api-key',
    envVar: 'GEMINI_API_KEY',
    model: 'gemini-3-pro-preview',
  },
  openrouter: {
    label: 'OpenRouter',
    format: 'openai-chat',
    baseUrl: 'https://openrouter.ai/api/v1',
    authType: 'bearer',
    envVar: 'OPENROUTER_API_KEY',
    model: '',
  },
  groq: {
    label: 'Groq',
    format: 'openai-chat',
    baseUrl: 'https://api.groq.com/openai/v1',
    authType: 'bearer',
    envVar: 'GROQ_API_KEY',
    model: '',
  },
  deepseek: {
    label: 'DeepSeek',
    format: 'openai-chat',
    baseUrl: 'https://api.deepseek.com',
    authType: 'bearer',
    envVar: 'DEEPSEEK_API_KEY',
    model: 'deepseek-chat',
  },
  moonshot: {
    label: 'Moonshot / Kimi',
    format: 'openai-chat',
    baseUrl: 'https://api.moonshot.ai/v1',
    authType: 'bearer',
    envVar: 'MOONSHOT_API_KEY',
    model: 'kimi-k2.5',
  },
  qianfan: {
    label: 'Baidu Qianfan',
    format: 'openai-chat',
    baseUrl: 'https://qianfan.baidubce.com/v2',
    authType: 'bearer',
    envVar: 'QIANFAN_API_KEY',
    model: 'deepseek-v3.2',
  },
  minimax: {
    label: 'MiniMax (Anthropic-compatible)',
    format: 'anthropic-messages',
    baseUrl: 'https://api.minimax.io/anthropic',
    authType: 'bearer',
    envVar: 'MINIMAX_API_KEY',
    model: 'MiniMax-M2.1',
  },
  xai: {
    label: 'xAI',
    format: 'openai-chat',
    baseUrl: 'https://api.x.ai/v1',
    authType: 'bearer',
    envVar: 'XAI_API_KEY',
    model: '',
  },
  mistral: {
    label: 'Mistral',
    format: 'openai-chat',
    baseUrl: 'https://api.mistral.ai/v1',
    authType: 'bearer',
    envVar: 'MISTRAL_API_KEY',
    model: '',
  },
  cerebras: {
    label: 'Cerebras',
    format: 'openai-chat',
    baseUrl: 'https://api.cerebras.ai/v1',
    authType: 'bearer',
    envVar: 'CEREBRAS_API_KEY',
    model: '',
  },
  zai: {
    label: 'Z.AI / GLM',
    format: 'openai-chat',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    authType: 'bearer',
    envVar: 'ZAI_API_KEY',
    model: '',
  },
  ollama: {
    label: 'Ollama (local)',
    format: 'openai-chat',
    baseUrl: 'http://127.0.0.1:11434/v1',
    authType: 'none',
    envVar: '',
    model: '',
  },
  lmstudio: {
    label: 'LM Studio (local)',
    format: 'openai-chat',
    baseUrl: 'http://127.0.0.1:1234/v1',
    authType: 'none',
    envVar: '',
    model: '',
  },
  'custom-openai': {
    label: 'Custom OpenAI-compatible',
    format: 'openai-chat',
    baseUrl: '',
    authType: 'bearer',
    envVar: '',
    model: '',
  },
  'custom-anthropic': {
    label: 'Custom Anthropic-compatible',
    format: 'anthropic-messages',
    baseUrl: '',
    authType: 'x-api-key',
    envVar: '',
    model: '',
  },
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

export function applyApiProviderPreset(settings: PluginSettings, providerId: string) {
  const previousPreset = getApiPreset(settings);
  const preset = API_PROVIDER_PRESETS[providerId] || API_PROVIDER_PRESETS.anthropic;
  const previousModel = (settings.model || '').trim();
  const shouldSwapModel =
    !previousModel ||
    previousModel === DEFAULT_SETTINGS.model ||
    (!!previousPreset.model && previousModel === previousPreset.model);

  settings.apiProvider = providerId;
  settings.apiFormat = preset.format;
  settings.apiBaseUrl = preset.baseUrl;
  settings.apiAuthType = preset.authType || 'auto';
  settings.apiKeyEnvVar = preset.envVar || '';
  if (shouldSwapModel) settings.model = preset.model || '';
}

export function normalizeSettings(settings: PluginSettings): PluginSettings {
  if (!(UI_LANGUAGES as Record<string, string>)[settings.uiLanguage]) settings.uiLanguage = DEFAULT_SETTINGS.uiLanguage;
  if (!settings.apiProvider || !API_PROVIDER_PRESETS[settings.apiProvider]) {
    settings.apiProvider = 'anthropic';
  }
  const preset = getApiPreset(settings);
  if (!settings.apiFormat || !API_FORMATS[settings.apiFormat]) settings.apiFormat = preset.format;
  if (!settings.apiAuthType || !(API_AUTH_TYPES as Record<string, string>)[settings.apiAuthType])
    settings.apiAuthType = 'auto';
  if (settings.backend === 'anthropic-api') {
    settings.apiProvider = settings.apiProvider || 'anthropic';
    settings.apiFormat = settings.apiFormat || 'anthropic-messages';
    settings.apiBaseUrl = settings.apiBaseUrl || API_PROVIDER_PRESETS.anthropic.baseUrl;
    settings.apiAuthType = settings.apiAuthType || 'x-api-key';
    settings.apiKeyEnvVar = settings.apiKeyEnvVar || 'ANTHROPIC_API_KEY';
  }
  const n = Number(settings.apiMaxTokens);
  if (!Number.isFinite(n) || n <= 0) settings.apiMaxTokens = DEFAULT_SETTINGS.apiMaxTokens;
  const maxDocChars = Number(settings.maxDocChars);
  if (!Number.isFinite(maxDocChars) || maxDocChars < 1000) settings.maxDocChars = DEFAULT_SETTINGS.maxDocChars;
  settings.maxCacheEntries = normalizeMaxCacheEntries(settings.maxCacheEntries);
  if (!(PROMPT_LANGUAGES as Record<string, string>)[settings.promptLanguage])
    settings.promptLanguage = DEFAULT_SETTINGS.promptLanguage;
  settings.minCards = normalizeCardCount(settings.minCards, DEFAULT_SETTINGS.minCards);
  settings.maxCards = normalizeCardCount(settings.maxCards, DEFAULT_SETTINGS.maxCards);
  if (settings.maxCards < settings.minCards) settings.maxCards = settings.minCards;
  if (typeof settings.customSystemPrompt !== 'string') settings.customSystemPrompt = '';
  return settings;
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
