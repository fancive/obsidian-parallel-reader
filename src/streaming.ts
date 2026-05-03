'use strict';

import { translate } from './i18n';
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
    } catch (_) {
      // skip non-JSON SSE lines
    }
  }
  return { deltas, rest };
}

export interface StreamProgress {
  accumulated: string;
  done: boolean;
}

async function doStreamingFetch(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  extractDelta: DeltaExtractor,
  onProgress: ((progress: StreamProgress) => void) | undefined,
  signal: AbortSignal,
  settings: PluginSettings | null | undefined,
): Promise<string> {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      translate(settings || null, 'errorProviderApiStatus', {
        label: 'Streaming',
        status: response.status,
        excerpt: text.slice(0, 500),
      }),
    );
  }

  if (!response.body) {
    throw new Error('Response has no body for streaming');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let accumulated = '';
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const result = parseSseBuffer(buffer, extractDelta);
      buffer = result.rest;

      for (const delta of result.deltas) {
        accumulated += delta;
      }
      if (result.deltas.length > 0) {
        onProgress?.({ accumulated, done: false });
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Flush any unterminated final SSE event (some providers close the stream
  // without a trailing \n\n, leaving the last delta in `buffer`).
  if (buffer.length > 0) {
    const tailBuffer = buffer.endsWith('\n\n') ? buffer : `${buffer}\n\n`;
    const tail = parseSseBuffer(tailBuffer, extractDelta);
    for (const delta of tail.deltas) accumulated += delta;
  }

  onProgress?.({ accumulated, done: true });
  return accumulated;
}

/**
 * Perform a streaming fetch with SSE parsing and configurable timeout.
 * Uses the native Fetch API (available in Electron/Obsidian).
 * Returns the full accumulated text when done.
 */
export async function streamingFetch(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  extractDelta: DeltaExtractor,
  onProgress?: (progress: StreamProgress) => void,
  signal?: AbortSignal,
  settings?: PluginSettings | null,
): Promise<string> {
  if (typeof fetch !== 'function') {
    throw new Error('Streaming requires fetch API');
  }

  const timeoutMs = settings?.streamingTimeoutMs ?? 120000;
  const timeoutController = new AbortController();
  let abortListener: (() => void) | null = null;

  if (signal) {
    abortListener = () => timeoutController.abort();
    signal.addEventListener('abort', abortListener, { once: true });
    if (signal.aborted) timeoutController.abort();
  }

  let timeoutId: number | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = activeWindow.setTimeout(() => {
      timeoutController.abort();
      reject(new Error(`Streaming timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      doStreamingFetch(url, headers, body, extractDelta, onProgress, timeoutController.signal, settings),
      timeoutPromise,
    ]);
  } finally {
    if (timeoutId !== null) activeWindow.clearTimeout(timeoutId);
    if (signal && abortListener) signal.removeEventListener('abort', abortListener);
  }
}
