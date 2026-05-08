'use strict';

import { translate } from './i18n';
import type { RequestUrlFunction } from './provider-request';
import type { PluginSettings } from './types';

/**
 * Extract delta text from an OpenAI Chat SSE chunk.
 * Shape: { choices: [{ delta: { content: "..." } }] }
 */
function openAiChatDelta(json: Record<string, unknown>): string {
  const choices = json.choices as Array<{ delta?: { content?: string } }> | undefined;
  return choices?.[0]?.delta?.content || '';
}

/**
 * Extract delta text from an Anthropic Messages SSE chunk.
 * Event types:
 *   content_block_delta → { delta: { text: "..." } }
 */
function anthropicDelta(json: Record<string, unknown>): string {
  if (json.type === 'content_block_delta') {
    const delta = json.delta as { text?: string } | undefined;
    return delta?.text || '';
  }
  return '';
}

export type DeltaExtractor = (json: Record<string, unknown>) => string;

export function deltaExtractorForFormat(format: string): DeltaExtractor | null {
  switch (format) {
    case 'openai-chat':
      return openAiChatDelta;
    case 'anthropic-messages':
      return anthropicDelta;
    default:
      return null;
  }
}

/**
 * Parse a buffer of SSE text into individual data payloads.
 * Returns { events: parsed JSON objects, rest: unconsumed buffer }.
 */
export function parseSseBuffer(buffer: string, extractDelta: DeltaExtractor): { deltas: string[]; rest: string } {
  const deltas: string[] = [];
  const normalized = buffer.replace(/\r\n/g, '\n');
  const chunks = normalized.split('\n\n');
  const rest = normalized.endsWith('\n\n') ? '' : (chunks.pop() ?? '');
  const eventChunks = normalized.endsWith('\n\n') ? chunks.slice(0, -1) : chunks;

  for (const eventChunk of eventChunks) {
    const dataLines: string[] = [];
    for (const line of eventChunk.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(line.startsWith('data: ') ? 6 : 5);
      dataLines.push(data);
    }
    if (dataLines.length === 0) continue;

    const data = dataLines.join('\n');
    if (data.trim() === '[DONE]') continue;
    try {
      const json = JSON.parse(data) as Record<string, unknown>;
      const delta = extractDelta(json);
      if (delta) deltas.push(delta);
    } catch {
      // skip non-JSON SSE lines
    }
  }
  return { deltas, rest };
}

export interface StreamProgress {
  accumulated: string;
  done: boolean;
}

async function doStreamingRequestUrl(
  requestUrlImpl: RequestUrlFunction,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  extractDelta: DeltaExtractor,
  onProgress: ((progress: StreamProgress) => void) | undefined,
  settings: PluginSettings | null | undefined,
): Promise<string> {
  let response: Awaited<ReturnType<RequestUrlFunction>>;
  try {
    response = await requestUrlImpl({
      url,
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      throw: false,
    });
  } catch (e: unknown) {
    throw new Error(
      translate(settings || null, 'errorProviderRequestFailed', {
        label: 'Streaming',
        error: e instanceof Error ? e.message : String(e),
      }),
    );
  }

  if (response.status >= 400) {
    throw new Error(
      translate(settings || null, 'errorProviderApiStatus', {
        label: 'Streaming',
        status: response.status,
        excerpt: (response.text || '').slice(0, 500),
      }),
    );
  }

  let accumulated = '';
  const text = response.text || '';
  const buffer = text.endsWith('\n\n') ? text : `${text}\n\n`;
  const result = parseSseBuffer(buffer, extractDelta);
  for (const delta of result.deltas) {
    accumulated += delta;
  }
  if (result.deltas.length > 0) {
    onProgress?.({ accumulated, done: false });
  }

  onProgress?.({ accumulated, done: true });
  return accumulated;
}

/**
 * Perform an Obsidian requestUrl call that asks providers for SSE output and parses
 * the complete response text. requestUrl is one-shot, so progress arrives after
 * the HTTP request completes rather than per network chunk.
 */
export async function streamingRequestUrl(
  requestUrlImpl: RequestUrlFunction,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  extractDelta: DeltaExtractor,
  onProgress?: (progress: StreamProgress) => void,
  signal?: AbortSignal,
  settings?: PluginSettings | null,
): Promise<string> {
  const timeoutMs = settings?.streamingTimeoutMs ?? 120000;
  let abortListener: (() => void) | null = null;
  let abortPromise: Promise<never> | null = null;

  if (signal) {
    if (signal.aborted) throw new Error('Streaming request aborted');
    abortPromise = new Promise<never>((_, reject) => {
      abortListener = () => reject(new Error('Streaming request aborted'));
      signal.addEventListener('abort', abortListener, { once: true });
    });
  }

  let timeoutId: number | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = activeWindow.setTimeout(() => {
      reject(new Error(`Streaming timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const requestPromise = doStreamingRequestUrl(
      requestUrlImpl,
      url,
      headers,
      body,
      extractDelta,
      onProgress,
      settings,
    );
    return await Promise.race(
      abortPromise ? [requestPromise, timeoutPromise, abortPromise] : [requestPromise, timeoutPromise],
    );
  } finally {
    if (timeoutId !== null) activeWindow.clearTimeout(timeoutId);
    if (signal && abortListener) signal.removeEventListener('abort', abortListener);
  }
}
