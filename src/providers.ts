'use strict';

import {
  API_FORMATS,
  getApiAuthType,
  getApiBaseUrl,
  getApiFormat,
  getApiKey,
  getApiPreset,
  modelForApi,
} from './settings';
import { translate } from './i18n';
import {
  ANTHROPIC_CARD_TOOL_NAME,
  anthropicCardTool,
  cardOutputSchema,
  normalizeCardsPayload,
  openAiJsonSchemaResponseFormat,
  openAiResponsesTextFormat,
  parseCardsJson,
} from './schema';

function endpointUrl(baseUrl, suffixes) {
  const base = baseUrl.replace(/\/+$/, '');
  for (const suffix of suffixes) {
    if (base.endsWith(suffix)) return base;
  }
  return base + suffixes[0];
}

function parseApiHeaders(raw, settings?) {
  const text = (raw || '').trim();
  if (!text) return {};
  if (text.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new Error(translate(settings, 'errorCustomHeadersJsonParse', { error: e.message }));
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(translate(settings, 'errorCustomHeadersJsonObject'));
    }
    const headers = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' && k.trim()) headers[k.trim()] = v;
    }
    return headers;
  }

  const headers = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(':');
    if (idx <= 0) {
      throw new Error(translate(settings, 'errorCustomHeadersLineFormat'));
    }
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key) headers[key] = value;
  }
  return headers;
}

function authHeaders(settings) {
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

function buildApiHeaders(settings, extra?) {
  return {
    'content-type': 'application/json',
    ...authHeaders(settings),
    ...(extra || {}),
    ...parseApiHeaders(settings.apiHeaders, settings),
  };
}

function responseJson(resp, label, settings?) {
  if (resp.json && typeof resp.json === 'object') return resp.json;
  try {
    return JSON.parse(resp.text || '{}');
  } catch (_) {
    throw new Error(translate(settings, 'errorProviderNonJson', {
      label,
      excerpt: (resp.text || '').slice(0, 500),
    }));
  }
}

async function requestJsonBody(requestUrlImpl, label, url, headers, body, settings?) {
  let resp;
  try {
    resp = await requestUrlImpl({
      url,
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      throw: false,
    });
  } catch (e) {
    throw new Error(translate(settings, 'errorProviderRequestFailed', {
      label,
      error: e.message || e,
    }));
  }

  if (resp.status >= 400) {
    throw new Error(translate(settings, 'errorProviderApiStatus', {
      label,
      status: resp.status,
      excerpt: (resp.text || '').slice(0, 500),
    }));
  }
  return responseJson(resp, label, settings);
}

function shouldRetryWithoutStructuredOutput(error) {
  const message = String(error && error.message ? error.message : error);
  if (!/(?:API (?:400|404|422):|API returned HTTP (?:400|404|422)|API 返回 HTTP (?:400|404|422))/.test(message)) return false;
  return /response_format|json_schema|responseJsonSchema|responseMimeType|tools?|tool_choice|unsupported|unrecognized|unknown|schema/i.test(message);
}

async function requestJsonBodyWithStructuredFallback(requestUrlImpl, label, url, headers, structuredBody, fallbackBody, settings?) {
  try {
    return await requestJsonBody(requestUrlImpl, label, url, headers, structuredBody, settings);
  } catch (e) {
    if (!fallbackBody || !shouldRetryWithoutStructuredOutput(e)) throw e;
    console.warn(`[parallel-reader] ${label} structured output rejected; retrying without structured output`, e);
    return requestJsonBody(requestUrlImpl, label + ' fallback', url, headers, fallbackBody, settings);
  }
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object') return part.text || part.output_text || '';
      return '';
    }).join('');
  }
  if (content && typeof content === 'object') {
    return content.text || content.output_text || '';
  }
  return '';
}

function textFromOpenAiResponses(json) {
  if (typeof json.output_text === 'string') return json.output_text;
  const parts = [];
  const walk = value => {
    if (!value) return;
    if (typeof value === 'string') return;
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (typeof value === 'object') {
      if (typeof value.text === 'string') parts.push(value.text);
      if (typeof value.output_text === 'string') parts.push(value.output_text);
      if (value.type === 'output_text' && typeof value.content === 'string') parts.push(value.content);
      if (value.content) walk(value.content);
      if (value.output) walk(value.output);
    }
  };
  walk(json.output);
  return parts.join('');
}

export function tokenLimitFieldForOpenAiChat(settings) {
  const preset = getApiPreset(settings);
  const format = API_FORMATS[getApiFormat(settings)] || {};
  return preset.tokenLimitField || format.tokenLimitField || 'max_tokens';
}

export function buildAnthropicMessagesBody(system, user, settings, options?) {
  const structured = !options || options.structured !== false;
  const body: any = {
    model: modelForApi(settings),
    max_tokens: Number(settings.apiMaxTokens) || 4096,
    system,
    messages: [{ role: 'user', content: user }],
  };
  if (structured) {
    body.tools = [anthropicCardTool()];
    body.tool_choice = { type: 'tool', name: ANTHROPIC_CARD_TOOL_NAME };
  }
  return body;
}

export function buildOpenAiChatBody(system, user, settings, options?) {
  const structured = !options || options.structured !== false;
  const body: any = {
    model: modelForApi(settings),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  body[tokenLimitFieldForOpenAiChat(settings)] = Number(settings.apiMaxTokens) || 4096;
  if (structured) {
    body.response_format = openAiJsonSchemaResponseFormat();
  }
  return body;
}

export function buildOpenAiResponsesBody(system, user, settings, options?) {
  const structured = !options || options.structured !== false;
  const body: any = {
    model: modelForApi(settings),
    instructions: system,
    input: user,
    max_output_tokens: Number(settings.apiMaxTokens) || 4096,
  };
  if (structured) {
    body.text = openAiResponsesTextFormat();
  }
  return body;
}

export function buildGeminiBody(system, user, settings, options?) {
  const structured = !options || options.structured !== false;
  const generationConfig: any = {
    temperature: 0,
    maxOutputTokens: Number(settings.apiMaxTokens) || 4096,
  };
  if (structured) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseJsonSchema = cardOutputSchema(false);
  }
  return {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig,
  };
}

function cardsFromAnthropicToolUse(json, settings?) {
  const content = Array.isArray(json && json.content) ? json.content : [];
  const block = content.find(c => c && c.type === 'tool_use' && c.name === ANTHROPIC_CARD_TOOL_NAME);
  if (!block) return null;
  if (typeof block.input === 'string') return parseCardsJson(block.input, settings);
  if (block.input && typeof block.input === 'object') return normalizeCardsPayload(block.input);
  return [];
}

async function summarizeViaAnthropicMessages(requestUrlImpl, system, user, settings) {
  const url = endpointUrl(getApiBaseUrl(settings), ['/messages']);
  const json = await requestJsonBodyWithStructuredFallback(
    requestUrlImpl,
    'Anthropic-compatible',
    url,
    buildApiHeaders(settings, { 'anthropic-version': '2023-06-01' }),
    buildAnthropicMessagesBody(system, user, settings),
    buildAnthropicMessagesBody(system, user, settings, { structured: false }),
    settings
  );

  const toolCards = cardsFromAnthropicToolUse(json, settings);
  if (toolCards) return toolCards;

  const text = (json.content || []).map(c => textFromContent(c)).join('').trim();
  return parseCardsJson(text, settings);
}

async function summarizeViaOpenAiChat(requestUrlImpl, system, user, settings) {
  const url = endpointUrl(getApiBaseUrl(settings), ['/chat/completions']);
  const json = await requestJsonBodyWithStructuredFallback(
    requestUrlImpl,
    'OpenAI-compatible Chat',
    url,
    buildApiHeaders(settings),
    buildOpenAiChatBody(system, user, settings),
    buildOpenAiChatBody(system, user, settings, { structured: false }),
    settings
  );
  const choice = (json.choices || [])[0] || {};
  const text = textFromContent(choice.message?.content || choice.text || '').trim();
  return parseCardsJson(text, settings);
}

async function summarizeViaOpenAiResponses(requestUrlImpl, system, user, settings) {
  const url = endpointUrl(getApiBaseUrl(settings), ['/responses']);
  const json = await requestJsonBodyWithStructuredFallback(
    requestUrlImpl,
    'OpenAI Responses',
    url,
    buildApiHeaders(settings),
    buildOpenAiResponsesBody(system, user, settings),
    buildOpenAiResponsesBody(system, user, settings, { structured: false }),
    settings
  );
  return parseCardsJson(textFromOpenAiResponses(json).trim(), settings);
}

async function summarizeViaGoogleGenerativeAi(requestUrlImpl, system, user, settings) {
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
    settings
  );
  const candidate = (json.candidates || [])[0] || {};
  const parts = candidate.content?.parts || [];
  const text = parts.map(p => textFromContent(p)).join('').trim();
  return parseCardsJson(text, settings);
}

export async function summarizeViaApi(requestUrlImpl, system, user, settings) {
  const format = getApiFormat(settings);
  switch (format) {
    case 'openai-chat':
      return summarizeViaOpenAiChat(requestUrlImpl, system, user, settings);
    case 'openai-responses':
      return summarizeViaOpenAiResponses(requestUrlImpl, system, user, settings);
    case 'google-generative-ai':
      return summarizeViaGoogleGenerativeAi(requestUrlImpl, system, user, settings);
    case 'anthropic-messages':
    default:
      return summarizeViaAnthropicMessages(requestUrlImpl, system, user, settings);
  }
}

export async function testApiBackend(requestUrlImpl, settings) {
  await summarizeViaApi(
    requestUrlImpl,
    '只输出 JSON：{"cards":[]}',
    '连通性测试：请原样输出 {"cards":[]}',
    settings
  );
  const format = getApiFormat(settings);
  return `${getApiPreset(settings).label} / ${API_FORMATS[format].label}`;
}
