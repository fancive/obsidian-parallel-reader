const { assert, t } = require('./test-setup');

const expectedExports = [
  'cardsToMarkdown',
  'cancellationNoticeKey',
  'summarizeDocument',
  'addIconButton',
  'addTextButton',
  'copyToClipboard',
  'resolveCliPath',
  'runCli',
  'buildPrompts',
  'buildOpenAiChatBody',
  'extractJson',
  'findLineForAnchor',
  'folderPathsForTarget',
  'getApiBaseUrl',
  'generationFingerprint',
  'hasUnsafeBatchFolderSegments',
  'CacheManager',
  'GenerationJobManager',
  'createBatchRunState',
  'modelForApi',
  'activeSectionLine',
  'touchCacheEntry',
  'nextCardIndex',
  'pruneCacheEntries',
  'removeCardAt',
  'activeIndexAfterCardDelete',
  'createRafThrottledHandler',
  'visibleTopProbeY',
  'serializeCacheFile',
  'shouldConfirmRegenerate',
  'translate',
  'updateCardAt',
  'validateBatchFolderInput',
  'normalizeSettings',
  'normalizeStreamingTimeoutMs',
  'normalizeCliTimeoutMs',
  'applyApiProviderPreset',
];

for (const name of expectedExports) {
  assert.strictEqual(typeof t[name], 'function', `test-exports should include ${name}`);
}

console.log('test exports tests passed');
