'use strict';

import { ANTHROPIC_CARD_TOOL_NAME, normalizeCardsPayload, parseCardsJson } from './schema';
import type { PluginSettings, RawCard } from './types';

export function textFromProviderContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const p = part as Record<string, unknown>;
          return typeof p.text === 'string' ? p.text : typeof p.output_text === 'string' ? p.output_text : '';
        }
        return '';
      })
      .join('');
  }
  if (content && typeof content === 'object') {
    const c = content as Record<string, unknown>;
    return typeof c.text === 'string' ? c.text : typeof c.output_text === 'string' ? c.output_text : '';
  }
  return '';
}

export function textFromOpenAiResponsesResponse(json: Record<string, unknown>): string {
  if (typeof json.output_text === 'string') return json.output_text;
  const parts: string[] = [];
  const walk = (value: unknown) => {
    if (!value) return;
    if (typeof value === 'string') return;
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (typeof value === 'object') {
      const v = value as Record<string, unknown>;
      if (typeof v.text === 'string') parts.push(v.text);
      if (typeof v.output_text === 'string') parts.push(v.output_text);
      if (v.type === 'output_text' && typeof v.content === 'string') parts.push(v.content);
      if (v.content) walk(v.content);
      if (v.output) walk(v.output);
    }
  };
  walk(json.output);
  return parts.join('');
}

export function cardsFromAnthropicToolUse(
  json: Record<string, unknown>,
  settings?: PluginSettings | null,
): RawCard[] | null {
  const content = Array.isArray(json?.content) ? (json.content as Array<Record<string, unknown>>) : [];
  const block = content.find((c) => c && c.type === 'tool_use' && c.name === ANTHROPIC_CARD_TOOL_NAME);
  if (!block) return null;
  if (typeof block.input === 'string') return parseCardsJson(block.input, settings);
  if (block.input && typeof block.input === 'object') return normalizeCardsPayload(block.input, settings);
  return [];
}

export function textFromAnthropicMessagesResponse(json: Record<string, unknown>): string {
  const contentBlocks = Array.isArray(json.content) ? (json.content as Array<unknown>) : [];
  return contentBlocks
    .map((c) => textFromProviderContent(c))
    .join('')
    .trim();
}

export function textFromOpenAiChatResponse(json: Record<string, unknown>): string {
  const choices = Array.isArray(json.choices) ? (json.choices as Array<Record<string, unknown>>) : [];
  const choice = choices[0] || {};
  const message = choice.message as Record<string, unknown> | undefined;
  return textFromProviderContent(message?.content ?? choice.text ?? '').trim();
}

export function textFromGoogleGenerativeAiResponse(json: Record<string, unknown>): string {
  const candidates = Array.isArray(json.candidates) ? (json.candidates as Array<Record<string, unknown>>) : [];
  const candidate = candidates[0] || {};
  const contentObj = candidate.content as Record<string, unknown> | undefined;
  const parts = Array.isArray(contentObj?.parts) ? (contentObj.parts as Array<unknown>) : [];
  return parts
    .map((p) => textFromProviderContent(p))
    .join('')
    .trim();
}
