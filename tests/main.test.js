/**
 * Architecture guard tests — verify source code structure invariants
 * that cannot be expressed via TypeScript types or lint rules.
 */
const fs = require('fs');
const path = require('path');
const { assert, t } = require('./test-setup');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.ts'), 'utf8');
const viewSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'view.ts'), 'utf8');

// View lifecycle guards
assert.ok(!/\basync\s+onOpen\s*\(/.test(viewSource), 'ParallelReaderView.onOpen should not be async without await');
assert.ok(!/\basync\s+onClose\s*\(\)\s*\{\s*\}/.test(viewSource), 'empty onClose should not be async');
assert.ok(/focusSummaryPane\s*\(\)/.test(viewSource), 'summary pane should expose a focus helper');
assert.ok(
  /\.focus\(\{\s*preventScroll:\s*true\s*\}\)/.test(viewSource),
  'summary pane focus should not scroll the page',
);
assert.ok(/moveActiveSection[\s\S]*focusSummaryPane/.test(viewSource), 'card navigation should focus the summary pane');

// Cache debounce guards
assert.ok(/scheduleCacheSave\s*\(/.test(mainSource), 'cache touch should use a debounced cache save path');
assert.ok(/flushCacheSave\s*\(/.test(mainSource), 'pending cache touches should be flushable');
assert.ok(/onunload[\s\S]*flushCacheSave/.test(mainSource), 'plugin unload should flush pending cache touches');
assert.ok(/cacheTouch[\s\S]*scheduleCacheSave/.test(mainSource), 'cacheTouch should schedule a cache save');
assert.ok(
  !/cacheTouch[\s\S]{0,220}await this\.saveCache/.test(mainSource),
  'cacheTouch should not synchronously write cache.json',
);
assert.ok(/handleFileRename[\s\S]*cacheManager\.move/.test(mainSource), 'file rename should delegate cache moves');
assert.ok(
  !/handleFileRename[\s\S]*cacheManager\.cache\[/.test(mainSource),
  'file rename should not mutate cache directly',
);

// Module extraction guards
assert.ok(!/function addIconButton/.test(mainSource), 'UI icon helper should live outside main.ts');
assert.ok(!/function addTextButton/.test(mainSource), 'UI text-button helper should live outside main.ts');
assert.ok(!/function copyToClipboard/.test(mainSource), 'clipboard helper should live outside main.ts');

// Export surface smoke test
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
];
for (const name of expectedExports) {
  assert.strictEqual(typeof t[name], 'function', `test-exports should include ${name}`);
}

console.log('tests passed');
