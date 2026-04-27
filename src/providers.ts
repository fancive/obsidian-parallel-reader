'use strict';

import { translate } from './i18n';
import {
  buildAnthropicMessagesBody,
  buildGeminiBody,
  buildOpenAiChatBody,
  buildOpenAiResponsesBody,
} from './provider-bodies';
import {
  cardsFromAnthropicToolUse,
  textFromAnthropicMessagesResponse,
  textFromGoogleGenerativeAiResponse,
  textFromOpenAiChatResponse,
  textFromOpenAiResponsesResponse,
} from './provider-parsers';
import { parseCardsJson } from './schema';
import {
  API_FORMATS,
  getApiAuthType,
  getApiBaseUrl,
  getApiFormat,
  getApiKey,
  getApiPreset,
  modelForApi,
} from './settings';
import { deltaExtractorForFormat, type StreamProgress, streamingFetch } from './streaming';
import type { PluginSettings, RawCard } from './types';

export {
  buildAnthropicMessagesBody,
  buildGeminiBody,
  buildOpenAiChatBody,
  buildOpenAiResponsesBody,
  tokenLimitFieldForOpenAiChat,
} from './provider-bodies';

/* ---------- Typed request/response shapes ---------- */

type RequestUrlFunction = (params: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  throw?: boolean;
}) => Promise<{ status: number; json: unknown; text: string }>;

function requiredDeltaExtractor(format: string) {
  const extractor = deltaExtractorForFormat(format);
  if (!extractor) throw new Error(`Streaming not supported for format: ${format}`);
  return extractor;
}

/* ---------- Helpers ---------- */

function endpointUrl(baseUrl: string, suffixes: string[]) {
  const base = baseUrl.replace(/\/+$/, '');
  for (const suffix of suffixes) {
    if (base.endsWith(suffix)) return base;
  }
  return base + suffixes[0];
}

export function parseApiHeaders(raw: string, settings?: PluginSettings | null): Record<string, string> {
  const text = (raw || '').trim();
  if (!text) return {};
  if (text.startsWith('{')) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text);
    } catch (e: unknown) {
      throw new Error(translate(settings || null, 'errorCustomHeadersJsonParse', { error: (e as Error).message }));
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(translate(settings || null, 'errorCustomHeadersJsonObject'));
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' && k.trim()) headers[k.trim()] = v;
    }
    return headers;
  }

  const headers: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(':');
    if (idx <= 0) {
      throw new Error(translate(settings || null, 'errorCustomHeadersLineFormat'));
    }
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key) headers[key] = value;
  }
  return headers;
}

function authHeaders(settings: PluginSettings): Record<string, string> {
  const authType = getApiAuthType(settings);
  if (authType === 'none') return {};
  const key = getApiKey(settings);
  if (!key) {
    const envVar = (settings.apiKeyEnvVar || getApiPreset(settings).envVar || '').trim();
    const hint = envVar ? translate(settings, 'errorApiKeyEnvHint', { envVar }) : '';
    throw new Error(translate(settings, 'errorApiKeyMissing', { hint }));
  }
  if (authType === 'bearer') return { authorization: `Bearer ${key}` };
  if (authType === 'x-api-key') return { 'x-api-key': key };
  if (authType === 'x-goog-api-key') return { 'x-goog-api-key': key };
  if (authType === 'api-key') return { 'api-key': key };
  return { authorization: `Bearer ${key}` };
}

function buildApiHeaders(settings: PluginSettings, extra?: Record<string, string>): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...authHeaders(settings),
    ...(extra || {}),
    ...parseApiHeaders(settings.apiHeaders, settings),
  };
}

function responseJson(
  resp: { json: unknown; text: string },
  label: string,
  settings?: PluginSettings | null,
): Record<string, unknown> {
  if (resp.json && typeof resp.json === 'object') return resp.json as Record<string, unknown>;
  try {
    return JSON.parse(resp.text || '{}') as Record<string, unknown>;
  } catch (_) {
    throw new Error(
      translate(settings || null, 'errorProviderNonJson', {
        label,
        excerpt: (resp.text || '').slice(0, 500),
      }),
    );
  }
}

async function requestJsonBody(
  requestUrlImpl: RequestUrlFunction,
  label: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  settings?: PluginSettings | null,
): Promise<Record<string, unknown>> {
  let resp: { status: number; json: unknown; text: string };
  try {
    resp = await requestUrlImpl({
      url,
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      throw: false,
    });
  } catch (e: unknown) {
    throw new Error(
      translate(settings || null, 'errorProviderRequestFailed', {
        label,
        error: (e as Error).message || String(e),
      }),
    );
  }

  if (resp.status >= 400) {
    throw new Error(
      translate(settings || null, 'errorProviderApiStatus', {
        label,
        status: resp.status,
        excerpt: (resp.text || '').slice(0, 500),
      }),
    );
  }
  return responseJson(resp, label, settings);
}

function shouldRetryWithoutStructuredOutput(error: unknown): boolean {
  const message = String((error as Error)?.message ?? error);
  if (!/(?:API (?:400|404|422):|API returned HTTP (?:400|404|422)|API 返回 HTTP (?:400|404|422))/.test(message))
    return false;
  return /response_format|json_schema|responseJsonSchema|responseMimeType|tools?|tool_choice|unsupported|unrecognized|unknown|schema/i.test(
    message,
  );
}

async function requestJsonBodyWithStructuredFallback(
  requestUrlImpl: RequestUrlFunction,
  label: string,
  url: string,
  headers: Record<string, string>,
  structuredBody: unknown,
  fallbackBody: unknown,
  settings?: PluginSettings | null,
): Promise<Record<string, unknown>> {
  try {
    return await requestJsonBody(requestUrlImpl, label, url, headers, structuredBody, settings);
  } catch (e: unknown) {
    if (!fallbackBody || !shouldRetryWithoutStructuredOutput(e)) throw e;
    console.warn(`[parallel-reader] ${label} structured output rejected; retrying without structured output`, e);
    return requestJsonBody(requestUrlImpl, label + ' fallback', url, headers, fallbackBody, settings);
  }
}

async function summarizeViaAnthropicMessages(
  requestUrlImpl: RequestUrlFunction,
  system: string,
  user: string,
  settings: PluginSettings,
) {
  const url = endpointUrl(getApiBaseUrl(settings), ['/messages']);
  const json = await requestJsonBodyWithStructuredFallback(
    requestUrlImpl,
    'Anthropic-compatible',
    url,
    buildApiHeaders(settings, { 'anthropic-version': '2023-06-01' }),
    buildAnthropicMessagesBody(system, user, settings),
    buildAnthropicMessagesBody(system, user, settings, { structured: false }),
    settings,
  );

  const toolCards = cardsFromAnthropicToolUse(json, settings);
  if (toolCards) return toolCards;

  return parseCardsJson(textFromAnthropicMessagesResponse(json), settings);
}

async function summarizeViaOpenAiChat(
  requestUrlImpl: RequestUrlFunction,
  system: string,
  user: string,
  settings: PluginSettings,
) {
  const url = endpointUrl(getApiBaseUrl(settings), ['/chat/completions']);
  const json = await requestJsonBodyWithStructuredFallback(
    requestUrlImpl,
    'OpenAI-compatible Chat',
    url,
    buildApiHeaders(settings),
    buildOpenAiChatBody(system, user, settings),
    buildOpenAiChatBody(system, user, settings, { structured: false }),
    settings,
  );
  return parseCardsJson(textFromOpenAiChatResponse(json), settings);
}

async function summarizeViaOpenAiResponses(
  requestUrlImpl: RequestUrlFunction,
  system: string,
  user: string,
  settings: PluginSettings,
) {
  const url = endpointUrl(getApiBaseUrl(settings), ['/responses']);
  const json = await requestJsonBodyWithStructuredFallback(
    requestUrlImpl,
    'OpenAI Responses',
    url,
    buildApiHeaders(settings),
    buildOpenAiResponsesBody(system, user, settings),
    buildOpenAiResponsesBody(system, user, settings, { structured: false }),
    settings,
  );
  return parseCardsJson(textFromOpenAiResponsesResponse(json).trim(), settings);
}

async function summarizeViaGoogleGenerativeAi(
  requestUrlImpl: RequestUrlFunction,
  system: string,
  user: string,
  settings: PluginSettings,
) {
  const model = encodeURIComponent(modelForApi(settings));
  let url = getApiBaseUrl(settings);
  if (!/:generateContent(?:\?|$)/.test(url)) {
    url = `${url.replace(/\/+$/, '')}/models/${model}:generateContent`;
  }
  const headers = buildApiHeaders(settings);
  const json = await requestJsonBodyWithStructuredFallback(
    requestUrlImpl,
    'Google Gemini',
    url,
    headers,
    buildGeminiBody(system, user, settings),
    buildGeminiBody(system, user, settings, { structured: false }),
    settings,
  );
  return parseCardsJson(textFromGoogleGenerativeAiResponse(json), settings);
}

// Obsidian's requestUrl is not directly compatible with fetch — we accept it as a typed callback
export async function summarizeViaApi(
  requestUrlImpl: RequestUrlFunction,
  system: string,
  user: string,
  settings: PluginSettings,
): Promise<RawCard[]> {
  const format = getApiFormat(settings);
  switch (format) {
    case 'openai-chat':
      return summarizeViaOpenAiChat(requestUrlImpl, system, user, settings);
    case 'openai-responses':
      return summarizeViaOpenAiResponses(requestUrlImpl, system, user, settings);
    case 'google-generative-ai':
      return summarizeViaGoogleGenerativeAi(requestUrlImpl, system, user, settings);
    default:
      return summarizeViaAnthropicMessages(requestUrlImpl, system, user, settings);
  }
}

export function supportsStreaming(settings: PluginSettings): boolean {
  if (!settings.streaming) return false;
  const format = getApiFormat(settings);
  return !!deltaExtractorForFormat(format);
}

async function streamSummarizeViaOpenAiChat(
  system: string,
  user: string,
  settings: PluginSettings,
  onProgress?: (progress: StreamProgress) => void,
  signal?: AbortSignal,
) {
  const url = endpointUrl(getApiBaseUrl(settings), ['/chat/completions']);
  const headers = buildApiHeaders(settings);
  const body = buildOpenAiChatBody(system, user, settings, { structured: false });
  body.stream = true;
  const extractor = requiredDeltaExtractor('openai-chat');
  const text = await streamingFetch(url, headers, body, extractor, onProgress, signal, settings);
  return parseCardsJson(text.trim(), settings);
}

async function streamSummarizeViaAnthropicMessages(
  system: string,
  user: string,
  settings: PluginSettings,
  onProgress?: (progress: StreamProgress) => void,
  signal?: AbortSignal,
) {
  const url = endpointUrl(getApiBaseUrl(settings), ['/messages']);
  const headers = buildApiHeaders(settings, { 'anthropic-version': '2023-06-01' });
  const body = buildAnthropicMessagesBody(system, user, settings, { structured: false });
  body.stream = true;
  const extractor = requiredDeltaExtractor('anthropic-messages');
  const text = await streamingFetch(url, headers, body, extractor, onProgress, signal, settings);
  return parseCardsJson(text.trim(), settings);
}

export async function summarizeViaApiStreaming(
  system: string,
  user: string,
  settings: PluginSettings,
  onProgress?: (progress: StreamProgress) => void,
  signal?: AbortSignal,
): Promise<RawCard[]> {
  const format = getApiFormat(settings);
  switch (format) {
    case 'openai-chat':
      return streamSummarizeViaOpenAiChat(system, user, settings, onProgress, signal);
    case 'anthropic-messages':
      return streamSummarizeViaAnthropicMessages(system, user, settings, onProgress, signal);
    default:
      throw new Error(`Streaming not supported for format: ${format}`);
  }
}

// Obsidian's requestUrl is not directly compatible with fetch — we accept it as a typed callback
export async function testApiBackend(requestUrlImpl: RequestUrlFunction, settings: PluginSettings): Promise<string> {
  await summarizeViaApi(requestUrlImpl, '只输出 JSON：{"cards":[]}', '连通性测试：请原样输出 {"cards":[]}', settings);
  const format = getApiFormat(settings);
  return `${getApiPreset(settings).label} / ${API_FORMATS[format].label}`;
}
