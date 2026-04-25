'use strict';

import type { PluginSettings, RawCard } from './types';
import { translate } from './i18n';

export const ANTHROPIC_CARD_TOOL_NAME = 'record_parallel_reader_cards';

export function collectJsonObjectCandidates(raw: string): string[] {
  const candidates = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c === '\\') {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }

    if (c === '"') {
      inString = true;
    } else if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      if (depth > 0) depth--;
      if (depth === 0 && start >= 0) {
        candidates.push(raw.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return candidates;
}

export function extractJson(text: string): string {
  const raw = (text || '').trim();
  if (!raw) return raw;

  try { JSON.parse(raw); return raw; } catch (_) { /* continue */ }

  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    const fenced = fence[1].trim();
    try { JSON.parse(fenced); return fenced; } catch (_) { /* continue */ }
  }

  const candidates = collectJsonObjectCandidates(raw);
  candidates.sort((a, b) => b.length - a.length);
  for (const c of candidates) {
    try { JSON.parse(c); return c; } catch (_) { /* skip */ }
  }
  return raw;
}

export function parseCardsJson(text: string, settings?: PluginSettings): RawCard[] {
  const jsonText = extractJson(text);
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(translate(settings, 'errorLlmNonJson', {
      excerpt: (text || '').slice(0, 500),
    }));
  }
  return normalizeCardsPayload(parsed);
}

export function normalizeCardsPayload(parsed: { cards?: unknown[] }): RawCard[] {
  const raw = parsed && Array.isArray(parsed.cards) ? parsed.cards : [];
  return raw
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    .map(c => ({
      title: typeof c.title === 'string' ? c.title : '(无标题)',
      anchor: typeof c.anchor === 'string' ? c.anchor : '',
      gist: typeof c.gist === 'string' ? c.gist : '',
      bullets: Array.isArray(c.bullets) ? (c.bullets as unknown[]).filter((b): b is string => typeof b === 'string') : [],
    }));
}

export function cardOutputSchema(strict: boolean) {
  const cardSchema: any = {
    type: 'object',
    properties: {
      title: { type: 'string' },
      anchor: { type: 'string' },
      gist: { type: 'string' },
      bullets: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    required: ['title', 'anchor', 'gist', 'bullets'],
  };
  const rootSchema: any = {
    type: 'object',
    properties: {
      cards: {
        type: 'array',
        items: cardSchema,
      },
    },
    required: ['cards'],
  };
  if (strict) {
    cardSchema.additionalProperties = false;
    rootSchema.additionalProperties = false;
  }
  return rootSchema;
}

export function openAiJsonSchemaResponseFormat() {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'parallel_reader_cards',
      strict: true,
      schema: cardOutputSchema(true),
    },
  };
}

export function openAiResponsesTextFormat() {
  return {
    format: {
      type: 'json_schema',
      name: 'parallel_reader_cards',
      strict: true,
      schema: cardOutputSchema(true),
    },
  };
}

export function anthropicCardTool() {
  return {
    name: ANTHROPIC_CARD_TOOL_NAME,
    description: 'Return the generated Parallel Reader summary cards.',
    input_schema: cardOutputSchema(true),
  };
}
