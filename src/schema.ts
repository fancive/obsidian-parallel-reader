'use strict';

import { translate } from './i18n';
import type { PluginSettings, RawCard } from './types';

export const ANTHROPIC_CARD_TOOL_NAME = 'record_parallel_reader_cards';

export function collectJsonObjectCandidates(raw: string): string[] {
  const candidates: string[] = [];
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

  try {
    JSON.parse(raw);
    return raw;
  } catch (_) {
    /* continue */
  }

  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    const fenced = fence[1].trim();
    try {
      JSON.parse(fenced);
      return fenced;
    } catch (_) {
      /* continue */
    }
  }

  const candidates = collectJsonObjectCandidates(raw);
  candidates.sort((a, b) => b.length - a.length);
  for (const c of candidates) {
    try {
      JSON.parse(c);
      return c;
    } catch (_) {
      /* skip */
    }
  }
  return raw;
}

/**
 * Attempt to salvage cards from truncated JSON.
 * When the LLM output is cut off mid-card (e.g. token limit), the outer
 * `{"cards":[...]}` never closes. This function locates the `"cards":[`
 * array, finds every complete `{...}` object inside it (skipping the
 * truncated tail), and reconstructs valid JSON.
 */
export function repairTruncatedCardsJson(text: string): string | null {
  const match = text.match(/\{\s*"cards"\s*:\s*\[/);
  if (!match || match.index === undefined) return null;

  const afterArrayOpen = match.index + match[0].length;
  const cardCandidates = collectJsonObjectCandidates(text.slice(afterArrayOpen));
  const validCards: string[] = [];
  for (const c of cardCandidates) {
    try {
      JSON.parse(c);
      validCards.push(c);
    } catch (_) {
      /* skip malformed card */
    }
  }
  if (validCards.length === 0) return null;
  return '{"cards":[' + validCards.join(',') + ']}';
}

export function parseCardsJson(text: string, settings?: PluginSettings | null): RawCard[] {
  const jsonText = extractJson(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (_e) {
    // Attempt to salvage complete cards from truncated output
    const repaired = repairTruncatedCardsJson(text);
    if (repaired) {
      try {
        parsed = JSON.parse(repaired);
        console.warn(
          '[parallel-reader] LLM output was truncated; salvaged',
          (parsed as { cards?: unknown[] }).cards?.length ?? 0,
          'complete cards. Consider increasing max tokens.',
        );
        return normalizeCardsPayload(parsed, settings);
      } catch (_) {
        /* repair failed, fall through to error */
      }
    }
    console.warn(
      '[parallel-reader] LLM returned non-JSON. length=',
      (text || '').length,
      'head=',
      (text || '').slice(0, 80),
    );
    throw new Error(
      translate(settings || null, 'errorLlmNonJson', {
        length: String((text || '').length),
      }),
    );
  }
  return normalizeCardsPayload(parsed, settings);
}

export function normalizeCardsPayload(parsed: unknown, settings?: PluginSettings | null): RawCard[] {
  const obj = parsed as { cards?: unknown[] } | null | undefined;
  const raw = obj && Array.isArray(obj.cards) ? obj.cards : [];
  const fallbackTitle = translate(settings ?? null, 'cardUntitled');
  return raw
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    .map((c) => ({
      title: typeof c.title === 'string' ? c.title : fallbackTitle,
      anchor: typeof c.anchor === 'string' ? c.anchor : '',
      gist: typeof c.gist === 'string' ? c.gist : '',
      bullets: Array.isArray(c.bullets)
        ? (c.bullets as unknown[]).filter((b): b is string => typeof b === 'string')
        : [],
    }));
}

interface JsonSchema {
  type: string;
  properties?: Record<string, unknown>;
  items?: unknown;
  required?: string[];
  additionalProperties?: boolean;
}

export function cardOutputSchema(strict: boolean): JsonSchema {
  const cardSchema: JsonSchema = {
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
  const rootSchema: JsonSchema = {
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
