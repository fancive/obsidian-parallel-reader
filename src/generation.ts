'use strict';

import { requestUrl } from 'obsidian';
import { findLineForAnchor } from './anchor';
import { summarizeViaClaudeCode, summarizeViaCodex } from './cli';
import type { GenerationJob } from './generation-job-manager';
import { buildPrompts } from './prompt';
import { summarizeViaApi, summarizeViaApiStreaming, supportsStreaming } from './providers';
import { isApiBackend } from './settings';
import type { StreamProgress } from './streaming';
import type { PluginSettings, RawCard, ResolvedCard } from './types';

export async function summarizeDocument(
  content: string,
  settings: PluginSettings,
  job: GenerationJob,
  onStreamProgress?: (progress: StreamProgress) => void,
) {
  const { system, user } = buildPrompts(content, settings);
  let cards: RawCard[];
  switch (settings.backend) {
    case 'claude-code':
      cards = await summarizeViaClaudeCode(system, user, settings, job);
      break;
    case 'codex':
      cards = await summarizeViaCodex(system, user, settings, job);
      break;
    default: {
      const useStreaming = supportsStreaming(settings);
      if (useStreaming) {
        const abortController = new AbortController();
        job.onCancel(() => abortController.abort());
        cards = await summarizeViaApiStreaming(system, user, settings, onStreamProgress, abortController.signal);
      } else {
        cards = await summarizeViaApi(requestUrl, system, user, settings);
      }
      break;
    }
  }
  const resolved: ResolvedCard[] = cards.map((c) => ({
    title: c.title,
    level: 2,
    anchor: c.anchor,
    gist: c.gist,
    startLine: findLineForAnchor(content, c.anchor),
    bullets: c.bullets,
  }));
  resolved.sort((a, b) => {
    if (a.startLine < 0 && b.startLine < 0) return 0;
    if (a.startLine < 0) return 1;
    if (b.startLine < 0) return -1;
    return a.startLine - b.startLine;
  });
  return resolved;
}

export function cancellationNoticeKey(settings: PluginSettings | null, job: GenerationJob | null) {
  if (job?.phase === 'generating' && settings && isApiBackend(settings.backend)) {
    return 'cancelRequestedApiInFlight';
  }
  return 'cancelRequested';
}
