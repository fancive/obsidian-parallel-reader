'use strict';

import {
  ANTHROPIC_CARD_TOOL_NAME,
  anthropicCardTool,
  cardOutputSchema,
  openAiJsonSchemaResponseFormat,
  openAiResponsesTextFormat,
} from './schema';
import { API_FORMATS, getApiFormat, getApiPreset, modelForApi } from './settings';
import type { PluginSettings } from './types';

/* ---------- Body type interfaces ---------- */

export interface AnthropicMessagesBody {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: string; content: string }>;
  tools?: unknown[];
  tool_choice?: { type: string; name: string };
  stream?: boolean;
}

export interface OpenAiChatBody {
  model: string;
  messages: Array<{ role: string; content: string }>;
  response_format?: unknown;
  stream?: boolean;
  [tokenField: string]: unknown;
}

export interface OpenAiResponsesBody {
  model: string;
  instructions: string;
  input: string;
  max_output_tokens: number;
  text?: unknown;
  stream?: boolean;
}

interface GeminiGenerationConfig {
  temperature: number;
  maxOutputTokens: number;
  responseMimeType?: string;
  responseJsonSchema?: unknown;
}

export interface GeminiBody {
  systemInstruction: { parts: Array<{ text: string }> };
  contents: Array<{ role: string; parts: Array<{ text: string }> }>;
  generationConfig: GeminiGenerationConfig;
}

/* ---------- Body builders ---------- */

export function tokenLimitFieldForOpenAiChat(settings: PluginSettings): string {
  const preset = getApiPreset(settings);
  const format = API_FORMATS[getApiFormat(settings)];
  return preset.tokenLimitField || format?.tokenLimitField || 'max_tokens';
}

export function buildAnthropicMessagesBody(
  system: string,
  user: string,
  settings: PluginSettings,
  options?: { structured?: boolean },
): AnthropicMessagesBody {
  const structured = !options || options.structured !== false;
  const body: AnthropicMessagesBody = {
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

export function buildOpenAiChatBody(
  system: string,
  user: string,
  settings: PluginSettings,
  options?: { structured?: boolean },
): OpenAiChatBody {
  const structured = !options || options.structured !== false;
  const body: OpenAiChatBody = {
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

export function buildOpenAiResponsesBody(
  system: string,
  user: string,
  settings: PluginSettings,
  options?: { structured?: boolean },
): OpenAiResponsesBody {
  const structured = !options || options.structured !== false;
  const body: OpenAiResponsesBody = {
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

export function buildGeminiBody(
  system: string,
  user: string,
  settings: PluginSettings,
  options?: { structured?: boolean },
): GeminiBody {
  const structured = !options || options.structured !== false;
  const generationConfig: GeminiGenerationConfig = {
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
