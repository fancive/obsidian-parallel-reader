'use strict';

export { default as ParallelReaderPlugin } from '../main';
export { findLineForAnchor } from './anchor';
export { testBackend } from './backend-test';
export {
  batchProgressVars,
  createBatchRunState,
  createBatchStats,
  hasUnsafeBatchFolderSegments,
  markBatchFileRunning,
  normalizeBatchFolderInput,
  recordBatchError,
  recordBatchProcessed,
  recordBatchSkip,
  requestBatchCancel,
  selectBatchFiles,
  shouldSkipBatchFile,
  validateBatchFolderInput,
} from './batch';
export { serializeCacheFile, shouldConfirmRegenerate, touchCacheEntry } from './cache';
export { CacheManager } from './cache-manager';
export { activeIndexAfterCardDelete, removeCardAt, updateCardAt } from './cards';
export { CliProcessError, resolveCliPath, runCli, summarizeViaClaudeCode, summarizeViaCodex } from './cli';
export { cancellationNoticeKey, summarizeDocument } from './generation';
export {
  classifyGenerationError,
  GenerationJobAlreadyRunningError,
  GenerationJobCancelledError,
  GenerationJobManager,
} from './generation-job-manager';
export { translate } from './i18n';
export { cardsToMarkdown } from './markdown';
export { activeSectionLine, nextCardIndex } from './navigation';
export { buildPrompts } from './prompt';
export {
  buildAnthropicMessagesBody,
  buildGeminiBody,
  buildOpenAiChatBody,
  buildOpenAiResponsesBody,
  parseApiHeaders,
  summarizeViaApi,
  supportsStreaming,
  tokenLimitFieldForOpenAiChat,
} from './providers';
export { collectJsonObjectCandidates, extractJson, normalizeCardsPayload, repairTruncatedCardsJson } from './schema';
export { createRafThrottledHandler, visibleTopProbeY } from './scroll';
export {
  applyApiProviderPreset,
  CACHE_SCHEMA_VERSION,
  cacheEntryMatches,
  generationFingerprint,
  getApiBaseUrl,
  modelForApi,
  normalizeCardCount,
  normalizeCliTimeoutMs,
  normalizeSettings,
  normalizeStreamingTimeoutMs,
  pruneCacheEntries,
} from './settings';
export { deltaExtractorForFormat, parseSseBuffer } from './streaming';
export { addIconButton, addTextButton, copyToClipboard } from './ui-helpers';
export { folderPathsForTarget } from './vault';
export { ParallelReaderView } from './view';
