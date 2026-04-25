const assert = require('assert');
const crypto = require('crypto');
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
    return {
      Plugin,
      ItemView,
      PluginSettingTab,
      Setting,
      Notice,
      MarkdownView,
      TFile,
      Menu,
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
assert.strictEqual(typeof t.cardsToMarkdown, 'function');
assert.strictEqual(typeof t.buildPrompts, 'function');
assert.strictEqual(typeof t.buildOpenAiChatBody, 'function');
assert.strictEqual(typeof t.extractJson, 'function');
assert.strictEqual(typeof t.findLineForAnchor, 'function');
assert.strictEqual(typeof t.generationFingerprint, 'function');
assert.strictEqual(typeof t.GenerationJobManager, 'function');
assert.strictEqual(typeof t.pruneCacheEntries, 'function');

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
  await testAnthropicToolUseParsing();
  console.log('tests passed');
})().catch(e => {
  console.error(e);
  process.exit(1);
});
