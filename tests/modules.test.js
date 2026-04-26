const assert = require('assert');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'obsidian') {
    class Plugin {}
    class ItemView { constructor(leaf) { this.leaf = leaf; this.containerEl = { children: [{}, {}] }; } }
    class PluginSettingTab {}
    class Setting {}
    class Notice {}
    class MarkdownView {}
    class TFile {}
    class Menu {}
    class Modal {}
    return {
      Plugin, ItemView, PluginSettingTab, Setting, Notice, MarkdownView, TFile, Menu, Modal,
      MarkdownRenderer: { render: async () => {} },
      requestUrl: async () => ({ status: 200, json: {}, text: '{}' }),
      setIcon: () => {},
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const t = require('../main.js').__test;

// ── anchor.ts ──

assert.strictEqual(t.findLineForAnchor('', 'hello'), -1, 'empty content returns -1');
assert.strictEqual(t.findLineForAnchor('hello world', ''), -1, 'empty anchor returns -1');
assert.strictEqual(t.findLineForAnchor('hello world', 'hello world'), 0, 'exact full match on line 0');
assert.strictEqual(t.findLineForAnchor('line0\nline1\nhello', 'hello'), 2, 'exact match on line 2');
assert.strictEqual(t.findLineForAnchor('line0\nline1\nhello world', '  hello world  '), 2, 'trimmed match');
assert.strictEqual(
  t.findLineForAnchor('intro\nThe quick brown fox jumps over the lazy dog\nend', 'The quick brown fox jumps'),
  1, 'prefix match at 60-char threshold'
);
assert.strictEqual(
  t.findLineForAnchor('a\nb\nc\nd\ne\nAlpha   beta\nGamma\tDelta\nlast', 'Alpha beta Gamma Delta'),
  5, 'normalized whitespace match returns correct line'
);
assert.strictEqual(t.findLineForAnchor('hello\nworld', 'zzz_not_found'), -1, 'unmatched anchor returns -1');
assert.strictEqual(
  t.findLineForAnchor('first line\nsecond with 日本語 text\nthird', '日本語'),
  1, 'unicode anchor match'
);

// ── schema.ts: collectJsonObjectCandidates & extractJson ──

const { extractJson, normalizeCardsPayload } = t;

assert.strictEqual(extractJson(''), '', 'empty text returns empty');
assert.strictEqual(extractJson('{"a":1}'), '{"a":1}', 'already-valid JSON returned as-is');
assert.strictEqual(
  JSON.parse(extractJson('prefix {"cards":[]} suffix')).cards.length,
  0, 'extracts JSON from surrounding text'
);
assert.strictEqual(
  JSON.parse(extractJson('```json\n{"cards":[]}\n```')).cards.length,
  0, 'extracts JSON from fenced code block'
);
assert.strictEqual(
  JSON.parse(extractJson('text {"a":1} and {"cards":[{"title":"T"}]} end')).cards[0].title,
  'T', 'picks the largest valid JSON object'
);
assert.strictEqual(extractJson('not json at all'), 'not json at all', 'non-JSON text returned as-is');

// extractJson with nested braces in strings
const nestedBraces = '{"cards":[{"title":"test {with} braces","anchor":"a","gist":"g","bullets":[]}]}';
assert.deepStrictEqual(JSON.parse(extractJson(nestedBraces)).cards[0].title, 'test {with} braces');

// ── schema.ts: normalizeCardsPayload ──

assert.deepStrictEqual(normalizeCardsPayload(null), [], 'null payload returns empty array');
assert.deepStrictEqual(normalizeCardsPayload({}), [], 'empty object returns empty array');
assert.deepStrictEqual(normalizeCardsPayload({ cards: [null, undefined, 42, 'str'] }), [], 'non-object items filtered');
assert.deepStrictEqual(
  normalizeCardsPayload({ cards: [{ title: 'T', anchor: 'A', gist: 'G', bullets: ['B'] }] }),
  [{ title: 'T', anchor: 'A', gist: 'G', bullets: ['B'] }],
  'valid card passes through'
);
assert.deepStrictEqual(
  normalizeCardsPayload({ cards: [{ title: 123, gist: null, bullets: [1, 'valid', null] }] }),
  [{ title: '(无标题)', anchor: '', gist: '', bullets: ['valid'] }],
  'non-string fields get defaults, non-string bullets filtered'
);

// ── cache.ts ──

assert.strictEqual(t.touchCacheEntry(null), null, 'touchCacheEntry on null returns null');
const entry = { generatedAt: '2024-01-01T00:00:00.000Z' };
t.touchCacheEntry(entry, '2024-06-01T00:00:00.000Z');
assert.strictEqual(entry.lastAccessedAt, '2024-06-01T00:00:00.000Z', 'touchCacheEntry sets lastAccessedAt');

const serialized = t.serializeCacheFile({ 'a.md': { cards: [] } });
const parsed = JSON.parse(serialized);
assert.strictEqual(parsed.version, 1, 'cache file has version 1');
assert.ok(parsed.entries['a.md'], 'cache file has entries');
assert.strictEqual(serialized.includes('\n'), false, 'cache file is single line');

assert.strictEqual(t.shouldConfirmRegenerate(null, true), false, 'null entry never confirms');
assert.strictEqual(t.shouldConfirmRegenerate(null, false), false);
assert.strictEqual(t.shouldConfirmRegenerate({ generatedAt: '2024-01-01' }, true), false, 'no updatedAt => no confirm');
assert.strictEqual(t.shouldConfirmRegenerate({ updatedAt: '2024-01-01' }, false), false, 'force=false => no confirm');
assert.strictEqual(t.shouldConfirmRegenerate({ updatedAt: '2024-01-01' }, true), true, 'edited + force => confirm');
assert.strictEqual(t.shouldConfirmRegenerate({ updatedAt: '  ' }, true), false, 'whitespace updatedAt => no confirm');

// ── cards.ts ──

const cards = [{ title: 'A' }, { title: 'B' }, { title: 'C' }];
assert.deepStrictEqual(t.removeCardAt(cards, 0), [{ title: 'B' }, { title: 'C' }], 'remove first');
assert.deepStrictEqual(t.removeCardAt(cards, 2), [{ title: 'A' }, { title: 'B' }], 'remove last');
assert.strictEqual(t.removeCardAt(cards, 0).length, 2, 'returns new array');
assert.strictEqual(cards.length, 3, 'original not mutated');
assert.deepStrictEqual(t.removeCardAt([], 0), [], 'empty array');
assert.deepStrictEqual(t.removeCardAt(cards, -1).length, 3, 'negative index no-op');
assert.deepStrictEqual(t.removeCardAt(cards, 5).length, 3, 'out of range no-op');

assert.strictEqual(t.activeIndexAfterCardDelete(0, 3, 0), 0, 'delete first active -> stays 0');
assert.strictEqual(t.activeIndexAfterCardDelete(2, 3, 2), 1, 'delete last active -> previous');
assert.strictEqual(t.activeIndexAfterCardDelete(0, 1, 0), -1, 'single card delete -> -1');
assert.strictEqual(t.activeIndexAfterCardDelete(1, 5, 3), 2, 'delete before active -> shift left');
assert.strictEqual(t.activeIndexAfterCardDelete(3, 5, 1), 1, 'delete after active -> no change');

const updated = t.updateCardAt(cards, 1, { title: 'B2', gist: 'new gist' });
assert.strictEqual(updated[1].title, 'B2');
assert.strictEqual(updated[1].gist, 'new gist');
assert.strictEqual(updated[0].title, 'A', 'other cards unchanged');
assert.strictEqual(cards[1].title, 'B', 'original not mutated');

// ── navigation.ts ──

assert.strictEqual(t.nextCardIndex(-1, 5, 1), 0, 'from none forward -> first');
assert.strictEqual(t.nextCardIndex(-1, 5, -1), 4, 'from none backward -> last');
assert.strictEqual(t.nextCardIndex(0, 5, 1), 1, 'step forward');
assert.strictEqual(t.nextCardIndex(4, 5, 1), 4, 'clamp at end');
assert.strictEqual(t.nextCardIndex(0, 5, -1), 0, 'clamp at start');
assert.strictEqual(t.nextCardIndex(2, 5, -1), 1, 'step backward');
assert.strictEqual(t.nextCardIndex(0, 0, 1), -1, 'empty list');
assert.strictEqual(t.nextCardIndex(0, -1, 1), -1, 'negative count');

assert.strictEqual(t.activeSectionLine([{ startLine: 10 }], 0), 10);
assert.strictEqual(t.activeSectionLine([{ startLine: -1 }], 0), -1, 'negative startLine');
assert.strictEqual(t.activeSectionLine([], 0), -1, 'empty sections');
assert.strictEqual(t.activeSectionLine([{ startLine: 5 }], -1), -1, 'negative index');
assert.strictEqual(t.activeSectionLine([{ startLine: 5 }], 1), -1, 'out of range index');
assert.strictEqual(t.activeSectionLine(null, 0), -1, 'null sections');

// ── markdown.ts ──

const md = t.cardsToMarkdown('Test Title', [
  { title: 'Section 1', anchor: 'original quote', gist: 'Summary', bullets: ['point a', 'point b'] },
  { title: 'Section 2', gist: 'Gist only', bullets: [] },
]);
assert.ok(md.includes('# Test Title'), 'top-level heading');
assert.ok(md.includes('## Section 1'), 'card heading');
assert.ok(md.includes('> original quote'), 'anchor blockquote');
assert.ok(md.includes('Summary'), 'gist included');
assert.ok(md.includes('- point a'), 'bullet list');
assert.ok(md.includes('## Section 2'), 'second card');
assert.ok(!md.includes('> \n'), 'no empty blockquote for card without anchor');

assert.strictEqual(t.cardsToMarkdown('', []), '# 对照笔记', 'empty title uses default');

// cardToPlain
const plain = t.cardsToMarkdown('X', []);
assert.ok(plain.includes('# X'));

// ── vault.ts ──

assert.deepStrictEqual(t.folderPathsForTarget(''), [], 'empty path');
assert.deepStrictEqual(t.folderPathsForTarget('A/B/C'), ['A', 'A/B', 'A/B/C']);
assert.deepStrictEqual(t.folderPathsForTarget('/A//B/'), ['A', 'A/B'], 'normalizes slashes');
assert.deepStrictEqual(t.folderPathsForTarget('single'), ['single']);

// ── i18n.ts ──

assert.strictEqual(t.translate({ uiLanguage: 'zh' }, 'appTitle'), '对照阅读笔记', 'zh translation');
assert.strictEqual(t.translate({ uiLanguage: 'en' }, 'appTitle'), 'Parallel Reader', 'en translation');
assert.strictEqual(t.translate({ uiLanguage: 'en' }, 'nonexistent_key'), 'nonexistent_key', 'missing key returns key');
assert.strictEqual(
  t.translate({ uiLanguage: 'en' }, 'cacheClearedAll', { count: 5 }),
  'Cleared 5 cache entries',
  'variable interpolation'
);
assert.strictEqual(
  t.translate({ uiLanguage: 'en' }, 'exported', { path: 'foo/bar.md' }),
  'Exported → foo/bar.md',
  'path variable'
);
// null settings -> resolveUiLanguage falls back to navigator.language; in Node.js there's no navigator, so defaults to 'en'
assert.strictEqual(
  t.translate(null, 'appTitle'),
  'Parallel Reader',
  'null settings defaults to en in Node.js (no navigator)'
);

// ── scroll.ts ──

assert.strictEqual(t.visibleTopProbeY({ top: 0, height: 0 }), 0, 'zero rect');
assert.strictEqual(t.visibleTopProbeY(null), 0, 'null rect');
assert.strictEqual(t.visibleTopProbeY({ top: 50, height: 500 }), 100, 'standard rect: min(80, 500*0.1)=50, 50+50=100');
assert.strictEqual(t.visibleTopProbeY({ top: 100, height: 300 }), 130, 'small rect offset 10%');
assert.strictEqual(t.visibleTopProbeY({ top: 100, height: 1200 }), 180, 'large rect capped at 80');

// createRafThrottledHandler already tested in main.test.js, test cancel behavior
const frames = [];
const throttled = t.createRafThrottledHandler(() => {}, cb => { frames.push(cb); return frames.length; });
throttled();
assert.strictEqual(frames.length, 1);
throttled.cancel();
throttled();
assert.strictEqual(frames.length, 2, 'new frame after cancel');

// ── settings.ts ──

const baseSettings = {
  backend: 'api',
  apiProvider: 'openai',
  apiFormat: 'openai-chat',
  apiBaseUrl: 'https://api.openai.com/v1',
  apiAuthType: 'bearer',
  apiKey: 'test-key',
  apiMaxTokens: 4096,
  model: 'openai/gpt-5.1',
};

// modelForApi strips provider prefix
assert.strictEqual(t.modelForApi({ ...baseSettings, model: 'openai/gpt-5.1' }), 'gpt-5.1', 'strip openai prefix');
assert.strictEqual(t.modelForApi({ ...baseSettings, model: 'gpt-5.1' }), 'gpt-5.1', 'no prefix pass-through');
assert.throws(() => t.modelForApi({ ...baseSettings, model: '' }), /Model/, 'empty model throws');

// getApiBaseUrl
assert.strictEqual(
  t.getApiBaseUrl({ ...baseSettings, apiBaseUrl: 'https://custom.ai/v1/' }),
  'https://custom.ai/v1',
  'strips trailing slash'
);
assert.throws(
  () => t.getApiBaseUrl({ ...baseSettings, apiProvider: 'custom-openai', apiBaseUrl: '' }),
  /Custom provider/,
  'custom provider without url throws'
);

// generationFingerprint stability
const fp1 = t.generationFingerprint(baseSettings);
const fp2 = t.generationFingerprint({ ...baseSettings });
assert.strictEqual(fp1, fp2, 'same settings = same fingerprint');
assert.notStrictEqual(fp1, t.generationFingerprint({ ...baseSettings, model: 'other' }), 'different model = different fp');
assert.notStrictEqual(fp1, t.generationFingerprint({ ...baseSettings, apiMaxTokens: 8192 }), 'different tokens = different fp');

// cacheEntryMatches
const crypto = require('crypto');
const hash = crypto.createHash('sha1').update('test', 'utf8').digest('hex');
assert.strictEqual(
  t.cacheEntryMatches({
    schemaVersion: t.CACHE_SCHEMA_VERSION,
    contentHash: hash,
    settingsHash: t.generationFingerprint(baseSettings),
  }, 'test', baseSettings),
  true, 'matching entry returns true'
);
assert.strictEqual(t.cacheEntryMatches(null, 'test', baseSettings), false, 'null entry returns false');

// pruneCacheEntries
const cache = {
  'a.md': { generatedAt: '2024-01-01' },
  'b.md': { generatedAt: '2024-01-03' },
  'c.md': { generatedAt: '2024-01-02', lastAccessedAt: '2024-01-05' },
};
const removed = t.pruneCacheEntries(cache, 2);
assert.deepStrictEqual(removed, ['a.md'], 'removes oldest by lastAccessedAt/generatedAt');
assert.strictEqual(Object.keys(cache).length, 2, 'cache pruned to max');
assert.ok(!cache['a.md'], 'oldest removed');
assert.ok(cache['b.md'] && cache['c.md'], 'newest kept');

// pruneCacheEntries with no pruning needed
const smallCache = { 'x.md': { generatedAt: '2024-01-01' } };
assert.deepStrictEqual(t.pruneCacheEntries(smallCache, 10), [], 'nothing pruned when under limit');

// ── prompt.ts ──

const enPrompt = t.buildPrompts('Hello world', {
  ...baseSettings,
  promptLanguage: 'en',
  minCards: 3,
  maxCards: 7,
});
assert.ok(enPrompt.system.includes('3-7'), 'card range in system prompt');
assert.ok(enPrompt.system.includes('English'), 'language instruction in english prompt');
assert.ok(enPrompt.user.includes('Source document:'), 'english user prompt prefix');
assert.ok(enPrompt.user.includes('Hello world'), 'content in user prompt');

const zhPrompt = t.buildPrompts('你好世界', {
  ...baseSettings,
  promptLanguage: 'zh',
  minCards: 2,
  maxCards: 5,
});
assert.ok(zhPrompt.system.includes('2-5'), 'zh card range');
assert.ok(zhPrompt.system.includes('中文'), 'chinese language instruction');
assert.ok(zhPrompt.user.includes('你好世界'), 'zh content');

// custom prompt with variables
const customPrompt = t.buildPrompts('doc', {
  ...baseSettings,
  promptLanguage: 'en',
  minCards: 1,
  maxCards: 3,
  customSystemPrompt: 'Generate {minCards} to {maxCards} cards. {languageInstruction}',
});
assert.ok(customPrompt.system.includes('Generate 1 to 3 cards'), 'custom prompt variable substitution');
assert.ok(customPrompt.system.includes('Non-overridable output contract'), 'contract appended to custom prompt');

// truncation
const longDoc = 'x'.repeat(25000);
const truncated = t.buildPrompts(longDoc, {
  ...baseSettings,
  promptLanguage: 'en',
  minCards: 1,
  maxCards: 3,
  maxDocChars: 20000,
});
assert.ok(truncated.user.includes('[Document truncated]'), 'truncation marker');
assert.ok(truncated.user.length < 25000, 'content actually truncated');

// ── providers.ts body builders ──

// OpenAI Chat body
const chatBody = t.buildOpenAiChatBody('sys', 'usr', { ...baseSettings, apiMaxTokens: 200 });
assert.strictEqual(chatBody.model, 'gpt-5.1', 'model stripped');
assert.strictEqual(chatBody.messages.length, 2, 'system + user messages');
assert.ok(chatBody.response_format, 'has structured output');

const chatUnstructured = t.buildOpenAiChatBody('sys', 'usr', baseSettings, { structured: false });
assert.strictEqual(chatUnstructured.response_format, undefined, 'no structured output when disabled');

// Anthropic Messages body
const anthBody = t.buildAnthropicMessagesBody('sys', 'usr', {
  ...baseSettings,
  apiProvider: 'anthropic',
  apiFormat: 'anthropic-messages',
  model: 'claude-sonnet-4-6',
});
assert.ok(anthBody.tools, 'has tools for structured output');
assert.strictEqual(anthBody.tools[0].name, 'record_parallel_reader_cards');
assert.strictEqual(anthBody.system, 'sys', 'system prompt set');

// OpenAI Responses body
const respBody = t.buildOpenAiResponsesBody('sys', 'usr', baseSettings);
assert.strictEqual(respBody.instructions, 'sys', 'instructions set');
assert.strictEqual(respBody.input, 'usr', 'input set');
assert.ok(respBody.text, 'has text format');

// Gemini body
const gemBody = t.buildGeminiBody('sys', 'usr', {
  ...baseSettings,
  apiProvider: 'google',
  apiFormat: 'google-generative-ai',
  model: 'gemini-3-pro-preview',
});
assert.strictEqual(gemBody.systemInstruction.parts[0].text, 'sys');
assert.strictEqual(gemBody.contents[0].parts[0].text, 'usr');
assert.strictEqual(gemBody.generationConfig.responseMimeType, 'application/json');

// tokenLimitFieldForOpenAiChat
assert.strictEqual(
  t.tokenLimitFieldForOpenAiChat({ ...baseSettings, apiProvider: 'openai' }),
  'max_completion_tokens',
  'OpenAI uses max_completion_tokens'
);
assert.strictEqual(
  t.tokenLimitFieldForOpenAiChat({ ...baseSettings, apiProvider: 'openrouter' }),
  'max_tokens',
  'OpenRouter uses max_tokens'
);

// ── generation-job-manager.ts: classifyGenerationError ──

assert.strictEqual(t.classifyGenerationError(new Error('API key 未设置')), 'auth');
assert.strictEqual(t.classifyGenerationError(new Error('API key is not set')), 'auth');
assert.strictEqual(t.classifyGenerationError(new Error('CLI timed out (120000ms)')), 'timeout');
assert.strictEqual(t.classifyGenerationError(new Error('CLI 超时 (120000ms)')), 'timeout');
assert.strictEqual(t.classifyGenerationError(new Error('API returned HTTP 429')), 'rate-limit');
assert.strictEqual(t.classifyGenerationError(new Error('json_schema validation failed')), 'schema');
assert.strictEqual(t.classifyGenerationError(new Error('LLM 返回非 JSON')), 'schema');
assert.strictEqual(t.classifyGenerationError(new Error('bad config value')), 'config');
assert.strictEqual(t.classifyGenerationError(new Error('random error')), 'unknown');
assert.strictEqual(t.classifyGenerationError(null), 'unknown', 'null error');
assert.strictEqual(t.classifyGenerationError('string error'), 'unknown', 'string error');

// ── streaming.ts ──

// supportsStreaming
assert.strictEqual(
  t.supportsStreaming({ ...baseSettings, streaming: true, apiFormat: 'openai-chat' }),
  true, 'OpenAI Chat supports streaming'
);
assert.strictEqual(
  t.supportsStreaming({ ...baseSettings, streaming: true, apiFormat: 'anthropic-messages', apiProvider: 'anthropic' }),
  true, 'Anthropic Messages supports streaming'
);
assert.strictEqual(
  t.supportsStreaming({ ...baseSettings, streaming: true, apiFormat: 'google-generative-ai', apiProvider: 'google' }),
  false, 'Gemini does not support streaming'
);
assert.strictEqual(
  t.supportsStreaming({ ...baseSettings, streaming: false, apiFormat: 'openai-chat' }),
  false, 'streaming disabled returns false'
);

// deltaExtractorForFormat
const openaiExtract = t.deltaExtractorForFormat('openai-chat');
assert.ok(openaiExtract, 'openai-chat extractor exists');
assert.strictEqual(
  openaiExtract({ choices: [{ delta: { content: 'hello' } }] }),
  'hello', 'extracts OpenAI delta'
);
assert.strictEqual(openaiExtract({ choices: [{ delta: {} }] }), '', 'empty delta');
assert.strictEqual(openaiExtract({}), '', 'missing choices');

const anthropicExtract = t.deltaExtractorForFormat('anthropic-messages');
assert.ok(anthropicExtract, 'anthropic extractor exists');
assert.strictEqual(
  anthropicExtract({ type: 'content_block_delta', delta: { text: 'world' } }),
  'world', 'extracts Anthropic delta'
);
assert.strictEqual(
  anthropicExtract({ type: 'message_start' }),
  '', 'non-delta event returns empty'
);

assert.strictEqual(t.deltaExtractorForFormat('google-generative-ai'), null, 'no extractor for gemini');

// parseSseBuffer
const sseResult = t.parseSseBuffer(
  'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"choices":[{"delta":{"content":" there"}}]}\ndata: [DONE]\npartial',
  openaiExtract,
);
assert.deepStrictEqual(sseResult.deltas, ['hi', ' there'], 'SSE parser extracts deltas');
assert.strictEqual(sseResult.rest, 'partial', 'SSE parser keeps partial line');

const sseEmpty = t.parseSseBuffer('', openaiExtract);
assert.deepStrictEqual(sseEmpty.deltas, []);
assert.strictEqual(sseEmpty.rest, '');

// Anthropic SSE format
const anthSse = t.parseSseBuffer(
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"token"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
  anthropicExtract,
);
assert.deepStrictEqual(anthSse.deltas, ['token'], 'Anthropic SSE extracts text delta');

console.log('modules tests passed');
