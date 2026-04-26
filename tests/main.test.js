const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'obsidian') {
    class Plugin {}
    class ItemView {
      constructor(leaf) {
        this.leaf = leaf;
        this.containerEl = { children: [{}, {}] };
      }
    }
    class PluginSettingTab {}
    class Setting {}
    class Notice {}
    class MarkdownView {}
    class TFile {}
    class Menu {}
    class Modal {}
    return {
      Plugin,
      ItemView,
      PluginSettingTab,
      Setting,
      Notice,
      MarkdownView,
      TFile,
      Menu,
      Modal,
      MarkdownRenderer: { render: async () => {} },
      requestUrl: async () => ({ status: 200, json: {}, text: '{}' }),
      setIcon: () => {},
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const plugin = require('../main.js');
const t = plugin.__test;

assert.ok(t, 'test helpers should be exported');
const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.ts'), 'utf8');
const viewSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'view.ts'), 'utf8');
assert.ok(!/\basync\s+onOpen\s*\(/.test(viewSource), 'ParallelReaderView.onOpen should not be async without await');
assert.ok(!/\basync\s+onClose\s*\(\)\s*\{\s*\}/.test(viewSource), 'empty onClose should not be async');
assert.ok(/focusSummaryPane\s*\(\)/.test(viewSource), 'summary pane should expose a focus helper');
assert.ok(/\.focus\(\{\s*preventScroll:\s*true\s*\}\)/.test(viewSource), 'summary pane focus should not scroll the page');
assert.ok(/moveActiveSection[\s\S]*focusSummaryPane/.test(viewSource), 'card navigation should focus the summary pane');
assert.ok(/scheduleCacheSave\s*\(/.test(mainSource), 'cache touch should use a debounced cache save path');
assert.ok(/flushCacheSave\s*\(/.test(mainSource), 'pending cache touches should be flushable');
assert.ok(/onunload[\s\S]*flushCacheSave/.test(mainSource), 'plugin unload should flush pending cache touches');
assert.ok(/cacheTouch[\s\S]*scheduleCacheSave/.test(mainSource), 'cacheTouch should schedule a cache save');
assert.ok(!/cacheTouch[\s\S]{0,220}await this\.saveCache/.test(mainSource), 'cacheTouch should not synchronously write cache.json');
assert.ok(/handleFileRename[\s\S]*cacheManager\.move/.test(mainSource), 'file rename should delegate cache moves');
assert.ok(!/handleFileRename[\s\S]*cacheManager\.cache\[/.test(mainSource), 'file rename should not mutate cache directly');
assert.ok(!/function addIconButton/.test(mainSource), 'UI icon helper should live outside main.ts');
assert.ok(!/function addTextButton/.test(mainSource), 'UI text-button helper should live outside main.ts');
assert.ok(!/function copyToClipboard/.test(mainSource), 'clipboard helper should live outside main.ts');
assert.strictEqual(typeof t.cardsToMarkdown, 'function');
assert.strictEqual(typeof t.cancellationNoticeKey, 'function');
assert.strictEqual(typeof t.summarizeDocument, 'function');
assert.strictEqual(typeof t.addIconButton, 'function');
assert.strictEqual(typeof t.addTextButton, 'function');
assert.strictEqual(typeof t.copyToClipboard, 'function');
assert.strictEqual(typeof t.resolveCliPath, 'function');
assert.strictEqual(typeof t.buildPrompts, 'function');
assert.strictEqual(typeof t.buildOpenAiChatBody, 'function');
assert.strictEqual(typeof t.extractJson, 'function');
assert.strictEqual(typeof t.findLineForAnchor, 'function');
assert.strictEqual(typeof t.folderPathsForTarget, 'function');
assert.strictEqual(typeof t.getApiBaseUrl, 'function');
assert.strictEqual(typeof t.generationFingerprint, 'function');
assert.strictEqual(typeof t.hasUnsafeBatchFolderSegments, 'function');
assert.strictEqual(typeof t.CacheManager, 'function');
assert.strictEqual(typeof t.GenerationJobManager, 'function');
assert.strictEqual(typeof t.createBatchRunState, 'function');
assert.strictEqual(typeof t.modelForApi, 'function');
assert.strictEqual(typeof t.activeSectionLine, 'function');
assert.strictEqual(typeof t.touchCacheEntry, 'function');
assert.strictEqual(typeof t.nextCardIndex, 'function');
assert.strictEqual(typeof t.pruneCacheEntries, 'function');
assert.strictEqual(typeof t.removeCardAt, 'function');
assert.strictEqual(typeof t.activeIndexAfterCardDelete, 'function');
assert.strictEqual(typeof t.createRafThrottledHandler, 'function');
assert.strictEqual(typeof t.visibleTopProbeY, 'function');
assert.strictEqual(typeof t.serializeCacheFile, 'function');
assert.strictEqual(typeof t.shouldConfirmRegenerate, 'function');
assert.strictEqual(typeof t.translate, 'function');
assert.strictEqual(typeof t.updateCardAt, 'function');
assert.strictEqual(typeof t.validateBatchFolderInput, 'function');

const baseSettings = {
  backend: 'api',
  apiProvider: 'openai',
  apiFormat: 'openai-chat',
  apiBaseUrl: 'https://api.openai.com/v1',
  apiAuthType: 'bearer',
  apiKey: 'test-key',
  apiMaxTokens: 123,
  model: 'openai/gpt-5.1',
};

assert.notStrictEqual(
  t.generationFingerprint(baseSettings),
  t.generationFingerprint({ ...baseSettings, model: 'openai/gpt-5.2' }),
  'cache fingerprint should change when model changes'
);
assert.notStrictEqual(
  t.generationFingerprint(baseSettings),
  t.generationFingerprint({ ...baseSettings, maxDocChars: 50000 }),
  'cache fingerprint should change when input truncation limit changes'
);
assert.notStrictEqual(
  t.generationFingerprint(baseSettings),
  t.generationFingerprint({ ...baseSettings, promptLanguage: 'en' }),
  'cache fingerprint should change when prompt language changes'
);
assert.notStrictEqual(
  t.generationFingerprint(baseSettings),
  t.generationFingerprint({ ...baseSettings, minCards: 3, maxCards: 8 }),
  'cache fingerprint should change when card count range changes'
);
assert.notStrictEqual(
  t.generationFingerprint(baseSettings),
  t.generationFingerprint({ ...baseSettings, customSystemPrompt: 'custom prompt' }),
  'cache fingerprint should change when custom prompt changes'
);
assert.strictEqual(
  t.generationFingerprint(baseSettings),
  t.generationFingerprint({ ...baseSettings, uiLanguage: 'en' }),
  'cache fingerprint should not change when UI language changes'
);
assert.strictEqual(
  t.cancellationNoticeKey({ backend: 'api' }, { phase: 'generating' }),
  'cancelRequestedApiInFlight',
  'API cancellation should explain that the in-flight network request cannot be aborted'
);
assert.strictEqual(
  t.cancellationNoticeKey({ backend: 'claude-code' }, { phase: 'generating' }),
  'cancelRequested',
  'CLI cancellation can use the generic cancellation notice'
);
assert.strictEqual(
  t.cancellationNoticeKey({ backend: 'api' }, { phase: 'reading' }),
  'cancelRequested',
  'API cancellation outside the request phase can use the generic notice'
);
assert.strictEqual(t.resolveCliPath('codex', '  /tmp/codex  '), '/tmp/codex');
assert.throws(
  () => t.modelForApi({ ...baseSettings, model: '', uiLanguage: 'en' }),
  /Model is not set/,
  'settings errors should respect English UI mode'
);
assert.throws(
  () => t.getApiBaseUrl({
    ...baseSettings,
    apiProvider: 'custom-openai-compatible',
    apiBaseUrl: '',
    uiLanguage: 'en',
  }),
  /Custom provider requires an API Base URL/,
  'custom provider base URL errors should respect English UI mode'
);

const contentHash = crypto.createHash('sha1').update('hello', 'utf8').digest('hex');
assert.strictEqual(
  t.cacheEntryMatches({
    schemaVersion: t.CACHE_SCHEMA_VERSION,
    contentHash,
    settingsHash: t.generationFingerprint(baseSettings),
  }, 'hello', baseSettings),
  true,
  'cache should match content, schema version, and generation fingerprint'
);
assert.strictEqual(
  t.cacheEntryMatches({
    schemaVersion: t.CACHE_SCHEMA_VERSION,
    contentHash,
    settingsHash: t.generationFingerprint({ ...baseSettings, model: 'openai/gpt-5.2' }),
  }, 'hello', baseSettings),
  false,
  'cache should miss when generation settings change'
);
assert.strictEqual(
  t.cacheEntryMatches({
    schemaVersion: t.CACHE_SCHEMA_VERSION - 1,
    contentHash,
    settingsHash: t.generationFingerprint(baseSettings),
  }, 'hello', baseSettings),
  false,
  'cache should miss when schema version changes'
);

const cacheForPrune = {
  'old.md': { generatedAt: '2024-01-01T00:00:00.000Z' },
  'new.md': { generatedAt: '2024-01-03T00:00:00.000Z' },
  'touched.md': {
    generatedAt: '2024-01-02T00:00:00.000Z',
    lastAccessedAt: '2024-01-04T00:00:00.000Z',
  },
};
assert.deepStrictEqual(t.pruneCacheEntries(cacheForPrune, 2), ['old.md']);
assert.deepStrictEqual(Object.keys(cacheForPrune).sort(), ['new.md', 'touched.md']);

assert.strictEqual(
  t.findLineForAnchor('intro\nAlpha   beta\nGamma\tDelta\nlast', 'Alpha beta Gamma Delta'),
  1,
  'whitespace-normalized anchor fallback should map back to the original source line'
);

const englishPrompt = t.buildPrompts('Hello world', {
  ...baseSettings,
  promptLanguage: 'en',
  minCards: 2,
  maxCards: 4,
});
assert.ok(englishPrompt.system.includes('2-4'));
assert.ok(englishPrompt.system.includes('Write title, gist, and bullets in English.'));
assert.ok(englishPrompt.system.includes('You are a long-form reading summary assistant.'));
assert.ok(!englishPrompt.system.includes('你是一个长文阅读摘要助手'));
assert.ok(englishPrompt.user.startsWith('Source document:'));

const customPrompt = t.buildPrompts('Hello world', {
  ...baseSettings,
  promptLanguage: 'auto',
  minCards: 1,
  maxCards: 2,
  customSystemPrompt: 'Make {minCards}-{maxCards} cards. {languageInstruction}',
});
assert.ok(customPrompt.system.includes('Make 1-2 cards.'));
assert.ok(customPrompt.system.includes('不可覆盖的输出契约'));
assert.ok(customPrompt.system.includes('JSON shape'));

assert.strictEqual(t.translate({ uiLanguage: 'en' }, 'cmdOpenView'), 'Open Parallel Reader pane');
assert.strictEqual(t.translate({ uiLanguage: 'zh' }, 'cmdOpenView'), '打开对照笔记面板');
assert.strictEqual(t.translate({ uiLanguage: 'en' }, 'cacheClearedAll', { count: 3 }), 'Cleared 3 cache entries');
assert.strictEqual(t.translate({ uiLanguage: 'en' }, 'cmdCardNext'), 'Focus next summary card');

assert.strictEqual(t.nextCardIndex(-1, 3, 1), 0);
assert.strictEqual(t.nextCardIndex(-1, 3, -1), 2);
assert.strictEqual(t.nextCardIndex(0, 3, 1), 1);
assert.strictEqual(t.nextCardIndex(2, 3, 1), 2);
assert.strictEqual(t.nextCardIndex(0, 3, -1), 0);
assert.strictEqual(t.nextCardIndex(0, 0, 1), -1);
assert.strictEqual(t.activeSectionLine([{ startLine: 3 }], 0), 3);
assert.strictEqual(t.activeSectionLine([{ startLine: -1 }], 0), -1);
assert.strictEqual(t.activeSectionLine([{ startLine: 3 }], 1), -1);
const scheduledFrames = [];
let throttledCalls = 0;
const throttled = t.createRafThrottledHandler(() => { throttledCalls += 1; }, cb => {
  scheduledFrames.push(cb);
  return scheduledFrames.length;
});
throttled();
throttled();
throttled();
assert.strictEqual(scheduledFrames.length, 1, 'scroll handler should be scheduled at most once per frame');
assert.strictEqual(throttledCalls, 0, 'throttled handler should not run synchronously');
scheduledFrames.shift()(0);
assert.strictEqual(throttledCalls, 1);
throttled();
assert.strictEqual(scheduledFrames.length, 1, 'scroll handler should be schedulable after the frame runs');
assert.strictEqual(t.visibleTopProbeY({ top: 100, height: 300 }), 130);
assert.strictEqual(t.visibleTopProbeY({ top: 100, height: 1200 }), 180);
const cardList = [{ title: 'A' }, { title: 'B' }, { title: 'C' }];
assert.deepStrictEqual(t.removeCardAt(cardList, 1), [{ title: 'A' }, { title: 'C' }]);
assert.deepStrictEqual(t.removeCardAt(cardList, -1), cardList);
assert.deepStrictEqual(t.removeCardAt(cardList, 3), cardList);
assert.notStrictEqual(t.removeCardAt(cardList, 3), cardList);
assert.strictEqual(t.activeIndexAfterCardDelete(1, 3, 1), 1, 'deleting active card should select the next card');
assert.strictEqual(t.activeIndexAfterCardDelete(2, 3, 2), 1, 'deleting the last active card should select the previous card');
assert.strictEqual(t.activeIndexAfterCardDelete(1, 3, 2), 1, 'deleting before active card should shift active index left');
assert.strictEqual(t.activeIndexAfterCardDelete(2, 3, 0), 0, 'deleting after active card should keep active index');
assert.deepStrictEqual(
  t.updateCardAt(cardList, 1, { title: 'B2', gist: 'G', bullets: ['x'] }),
  [{ title: 'A' }, { title: 'B2', gist: 'G', bullets: ['x'] }, { title: 'C' }]
);
assert.deepStrictEqual(t.updateCardAt(cardList, -1, { title: 'X' }), cardList);
assert.deepStrictEqual(t.updateCardAt(cardList, 3, { title: 'X' }), cardList);
assert.notStrictEqual(t.updateCardAt(cardList, 3, { title: 'X' }), cardList);
assert.deepStrictEqual(t.folderPathsForTarget('Reading/Articles'), ['Reading', 'Reading/Articles']);
assert.deepStrictEqual(t.folderPathsForTarget('/Reading//Articles/'), ['Reading', 'Reading/Articles']);
assert.deepStrictEqual(t.folderPathsForTarget('Reading'), ['Reading']);
assert.deepStrictEqual(t.folderPathsForTarget(''), []);
const untouchedCacheEntry = { generatedAt: '2024-01-01T00:00:00.000Z' };
assert.strictEqual(t.touchCacheEntry(null), null);
const touchedEntry = t.touchCacheEntry(untouchedCacheEntry, '2024-01-05T00:00:00.000Z');
assert.notStrictEqual(touchedEntry, untouchedCacheEntry, 'touchCacheEntry returns new object');
assert.strictEqual(touchedEntry.lastAccessedAt, '2024-01-05T00:00:00.000Z', 'touched entry has updated timestamp');
assert.strictEqual(untouchedCacheEntry.lastAccessedAt, undefined, 'original entry not mutated');
assert.strictEqual(t.shouldConfirmRegenerate({ updatedAt: '2024-01-05T00:00:00.000Z' }, true), true);
assert.strictEqual(t.shouldConfirmRegenerate({ updatedAt: '2024-01-05T00:00:00.000Z' }, false), false);
assert.strictEqual(t.shouldConfirmRegenerate({ generatedAt: '2024-01-01T00:00:00.000Z' }, true), false);
assert.strictEqual(t.shouldConfirmRegenerate(null, true), false);
const serializedCache = t.serializeCacheFile({
  'note.md': { generatedAt: '2024-01-01T00:00:00.000Z', cards: [{ title: 'A' }] },
});
assert.strictEqual(serializedCache.includes('\n'), false, 'cache.json should be compact');
assert.deepStrictEqual(JSON.parse(serializedCache).entries['note.md'].cards, [{ title: 'A' }]);

const noisyJson = '说明文字 {"cards":[{"title":"A","anchor":"保留 { 花括号 } 字符","gist":"G","bullets":["B"]}]} trailing';
const extracted = t.extractJson(noisyJson);
assert.deepStrictEqual(JSON.parse(extracted).cards[0].bullets, ['B']);

const openAiChatBody = t.buildOpenAiChatBody('system JSON', 'user', baseSettings);
assert.strictEqual(openAiChatBody.max_completion_tokens, 123);
assert.strictEqual(openAiChatBody.max_tokens, undefined);
assert.strictEqual(openAiChatBody.response_format.type, 'json_schema');

const compatChatBody = t.buildOpenAiChatBody('system JSON', 'user', {
  ...baseSettings,
  apiProvider: 'openrouter',
  model: 'openrouter/anthropic/claude-sonnet-4-5',
});
assert.strictEqual(compatChatBody.max_tokens, 123);
assert.strictEqual(compatChatBody.max_completion_tokens, undefined);
assert.strictEqual(compatChatBody.response_format.type, 'json_schema');

const responsesBody = t.buildOpenAiResponsesBody('system JSON', 'user', baseSettings);
assert.strictEqual(responsesBody.text.format.type, 'json_schema');

const geminiBody = t.buildGeminiBody('system JSON', 'user', {
  ...baseSettings,
  apiProvider: 'google',
  apiFormat: 'google-generative-ai',
});
assert.strictEqual(geminiBody.generationConfig.responseMimeType, 'application/json');
assert.strictEqual(geminiBody.generationConfig.responseJsonSchema.type, 'object');

const anthropicBody = t.buildAnthropicMessagesBody('system JSON', 'user', {
  ...baseSettings,
  apiProvider: 'anthropic',
  apiFormat: 'anthropic-messages',
  model: 'anthropic/claude-sonnet-4-6',
});
assert.strictEqual(anthropicBody.tools[0].name, 'record_parallel_reader_cards');
assert.strictEqual(anthropicBody.tool_choice.name, 'record_parallel_reader_cards');
assert.strictEqual(
  t.buildAnthropicMessagesBody('system JSON', 'user', baseSettings, { structured: false }).tools,
  undefined
);

const markdown = t.cardsToMarkdown('Example', [{
  title: '第一段',
  anchor: '原文引用',
  gist: '核心摘要',
  bullets: ['要点 A', '要点 B'],
}]);
assert.ok(markdown.includes('# Example'));
assert.ok(markdown.includes('## 第一段'));
assert.ok(markdown.includes('- 要点 A'));

async function testOpenAiStructuredFallback() {
  const calls = [];
  const requestUrlImpl = async req => {
    const body = JSON.parse(req.body);
    calls.push(body);
    if (calls.length === 1) {
      return { status: 400, text: 'unsupported response_format json_schema' };
    }
    return {
      status: 200,
      json: {
        choices: [{
          message: {
            content: '{"cards":[{"title":"T","anchor":"A","gist":"G","bullets":["B"]}]}',
          },
        }],
      },
    };
  };

  const originalWarn = console.warn;
  console.warn = () => {};
  let cards;
  try {
    cards = await t.summarizeViaApi(requestUrlImpl, 'system JSON', 'user', baseSettings);
  } finally {
    console.warn = originalWarn;
  }
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].response_format.type, 'json_schema');
  assert.strictEqual(calls[1].response_format, undefined);
  assert.deepStrictEqual(cards, [{ title: 'T', anchor: 'A', gist: 'G', bullets: ['B'] }]);
}

async function testProviderMissingApiKeyUsesEnglishUi() {
  await assert.rejects(
    () => t.summarizeViaApi(async () => {
      throw new Error('request should not be sent');
    }, 'system JSON', 'user', {
      ...baseSettings,
      apiKey: '',
      apiKeyEnvVar: '',
      uiLanguage: 'en',
    }),
    /API key is not set/
  );
}

async function testProviderHeaderJsonErrorUsesEnglishUi() {
  await assert.rejects(
    () => t.summarizeViaApi(async () => {
      throw new Error('request should not be sent');
    }, 'system JSON', 'user', {
      ...baseSettings,
      apiHeaders: '{"x":',
      uiLanguage: 'en',
    }),
    /Custom headers JSON parse failed/
  );
}

async function testProviderResponseNonJsonUsesEnglishUi() {
  await assert.rejects(
    () => t.summarizeViaApi(async () => ({
      status: 200,
      text: '<html>not json</html>',
    }), 'system JSON', 'user', {
      ...baseSettings,
      uiLanguage: 'en',
    }),
    /OpenAI-compatible Chat returned non-JSON/
  );
}

async function testProviderRequestFailureUsesEnglishUi() {
  await assert.rejects(
    () => t.summarizeViaApi(async () => {
      throw new Error('network down');
    }, 'system JSON', 'user', {
      ...baseSettings,
      uiLanguage: 'en',
    }),
    /OpenAI-compatible Chat request failed: network down/
  );
}

async function testProviderApiStatusErrorUsesEnglishUi() {
  await assert.rejects(
    () => t.summarizeViaApi(async () => ({
      status: 500,
      text: 'upstream exploded',
    }), 'system JSON', 'user', {
      ...baseSettings,
      uiLanguage: 'en',
    }),
    /OpenAI-compatible Chat API returned HTTP 500: upstream exploded/
  );
}

async function testSchemaNonJsonErrorUsesEnglishUi() {
  await assert.rejects(
    () => t.summarizeViaApi(async () => ({
      status: 200,
      json: {
        choices: [{
          message: {
            content: 'not json',
          },
        }],
      },
    }), 'system JSON', 'user', {
      ...baseSettings,
      uiLanguage: 'en',
    }),
    /LLM returned non-JSON/
  );
}

async function testAnthropicToolUseParsing() {
  const requestUrlImpl = async req => {
    const body = JSON.parse(req.body);
    assert.strictEqual(body.tools[0].name, 'record_parallel_reader_cards');
    assert.strictEqual(body.tool_choice.name, 'record_parallel_reader_cards');
    return {
      status: 200,
      json: {
        content: [{
          type: 'tool_use',
          name: 'record_parallel_reader_cards',
          input: {
            cards: [{ title: 'A', anchor: 'quote', gist: 'gist', bullets: ['one'] }],
          },
        }],
      },
    };
  };

  const cards = await t.summarizeViaApi(requestUrlImpl, 'system JSON', 'user', {
    ...baseSettings,
    apiProvider: 'anthropic',
    apiFormat: 'anthropic-messages',
    apiBaseUrl: 'https://api.anthropic.com/v1',
    apiAuthType: 'x-api-key',
    model: 'anthropic/claude-sonnet-4-6',
  });
  assert.deepStrictEqual(cards, [{ title: 'A', anchor: 'quote', gist: 'gist', bullets: ['one'] }]);
}

(async () => {
  await testOpenAiStructuredFallback();
  await testProviderMissingApiKeyUsesEnglishUi();
  await testProviderHeaderJsonErrorUsesEnglishUi();
  await testProviderResponseNonJsonUsesEnglishUi();
  await testProviderRequestFailureUsesEnglishUi();
  await testProviderApiStatusErrorUsesEnglishUi();
  await testSchemaNonJsonErrorUsesEnglishUi();
  await testAnthropicToolUseParsing();
  console.log('tests passed');
})().catch(e => {
  console.error(e);
  process.exit(1);
});
