const assert = require('assert');
const Module = require('module');

const originalLoad = Module._load;
let requestUrlMock = async () => ({ status: 200, json: {}, text: '{}' });
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
      requestUrl: (params) => requestUrlMock(params),
      setIcon: () => {},
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const t = require('../main.js').__test;

function openAiCardsResponse(cards) {
  const json = {
    choices: [{
      message: {
        content: JSON.stringify({ cards }),
      },
    }],
  };
  return { status: 200, json, text: JSON.stringify(json) };
}

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
const touched = t.touchCacheEntry(entry, '2024-06-01T00:00:00.000Z');
assert.strictEqual(touched.lastAccessedAt, '2024-06-01T00:00:00.000Z', 'touchCacheEntry sets lastAccessedAt on returned entry');
assert.strictEqual(entry.lastAccessedAt, undefined, 'touchCacheEntry does not mutate original entry');

const serialized = t.serializeCacheFile({ 'a.md': { cards: [] } });
const parsed = JSON.parse(serialized);
assert.strictEqual(parsed.version, 1, 'cache file has version 1');
assert.ok(parsed.entries['a.md'], 'cache file has entries');
assert.strictEqual(serialized.includes('\n'), false, 'cache file is single line');

async function testCacheManagerMove() {
  const writes = [];
  const adapter = {
    exists: async () => true,
    mkdir: async () => {},
    read: async () => '{}',
    write: async (filePath, content) => writes.push({ filePath, content }),
  };
  const manager = new t.CacheManager(adapter, '.obsidian', 'parallel-reader', () => ({
    maxCacheEntries: 100,
  }));
  const cacheEntry = { generatedAt: '2024-01-01T00:00:00.000Z', cards: [{ title: 'Card' }] };
  manager.cache = {
    'old.md': cacheEntry,
    'other.md': { generatedAt: '2024-01-02T00:00:00.000Z', cards: [] },
  };

  assert.strictEqual(await manager.move('missing.md', 'new.md'), false, 'missing cache move returns false');
  assert.strictEqual(await manager.move('missing.md', 'missing.md'), false, 'missing same-path move returns false');
  assert.strictEqual(await manager.move('  ', 'new.md'), false, 'blank source path is rejected');
  assert.strictEqual(await manager.move('old.md', '   '), false, 'blank target path is rejected');
  assert.strictEqual(await manager.move('old.md', 'old.md'), true, 'same-path move is a no-op success');
  assert.strictEqual(await manager.move('old.md', 'other.md'), false, 'move does not overwrite an existing target path');
  assert.strictEqual(writes.length, 0, 'no-op and rejected cache moves are not persisted');
  assert.strictEqual(await manager.move('old.md', 'new.md'), true, 'existing cache move returns true');
  assert.strictEqual(manager.cache['old.md'], undefined, 'old cache path is removed');
  assert.deepStrictEqual(manager.cache['new.md'], cacheEntry, 'cache entry is moved to new path');
  assert.ok(manager.cache['other.md'], 'unrelated cache entries remain');
  assert.strictEqual(writes.length, 1, 'successful cache move is persisted once');
  assert.ok(JSON.parse(writes[0].content).entries['new.md'], 'persisted cache uses moved path');
}

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
assert.deepStrictEqual(t.folderPathsForTarget('../../etc/passwd'), ['etc', 'etc/passwd'], 'strips .. path traversal');
assert.deepStrictEqual(t.folderPathsForTarget('./a/../b'), ['a', 'a/b'], 'strips . and .. segments');
assert.deepStrictEqual(t.folderPathsForTarget('a/../../b'), ['a', 'a/b'], 'strips mid-path ..');

// ── batch.ts ──

assert.strictEqual(t.normalizeBatchFolderInput('/Reading//Articles/'), 'Reading/Articles', 'normalizes folder input');
assert.strictEqual(t.normalizeBatchFolderInput('../Inbox/./Daily'), 'Inbox/Daily', 'strips unsafe folder segments');
assert.strictEqual(t.hasUnsafeBatchFolderSegments('../Inbox/./Daily'), true, 'unsafe folder segments are detected');
assert.strictEqual(t.hasUnsafeBatchFolderSegments('/Reading//Articles/'), false, 'normal folder paths are safe');
assert.deepStrictEqual(
  t.validateBatchFolderInput('', () => false),
  { valid: true, reason: 'ok', folderPath: '' },
  'empty batch folder targets vault root',
);
assert.deepStrictEqual(
  t.validateBatchFolderInput('Reading', (path) => path === 'Reading'),
  { valid: true, reason: 'ok', folderPath: 'Reading' },
  'existing folder input is valid',
);
assert.deepStrictEqual(
  t.validateBatchFolderInput('../Reading', () => true),
  { valid: false, reason: 'unsafe', folderPath: 'Reading' },
  'unsafe folder input is invalid even if normalized target exists',
);
assert.deepStrictEqual(
  t.validateBatchFolderInput('Missing', () => false),
  { valid: false, reason: 'missing', folderPath: 'Missing' },
  'missing folder input is invalid',
);
const batchFiles = [
  { path: 'root.md', parent: null },
  { path: 'Reading/note.md', parent: { path: 'Reading' } },
  { path: 'Reading/Deep/nested.md', parent: { path: 'Reading/Deep' } },
];
assert.deepStrictEqual(t.selectBatchFiles(batchFiles, '').map((file) => file.path), ['root.md'], 'root folder only');
assert.deepStrictEqual(
  t.selectBatchFiles(batchFiles, '/Reading/').map((file) => file.path),
  ['Reading/note.md'],
  'selected folder is non-recursive',
);
assert.deepStrictEqual(t.batchProgressVars(1, 3), { current: 2, total: 3 }, 'progress vars are one-based');
const batchStats = t.createBatchStats(3);
const skippedStats = t.recordBatchSkip(batchStats);
const processedStats = t.recordBatchProcessed(skippedStats);
assert.deepStrictEqual(batchStats, { total: 3, processed: 0, skipped: 0 }, 'batch stats are immutable');
assert.deepStrictEqual(skippedStats, { total: 3, processed: 1, skipped: 1 }, 'batch skip updates progress');
assert.deepStrictEqual(processedStats, { total: 3, processed: 2, skipped: 1 }, 'batch processed count accumulates');

const batchState = t.createBatchRunState();
assert.deepStrictEqual(batchState, { cancelled: false, currentPath: '' }, 'batch state starts idle');
assert.strictEqual(t.markBatchFileRunning(batchState, 'Reading/a.md'), batchState, 'batch state updates in place');
assert.strictEqual(batchState.currentPath, 'Reading/a.md', 'batch state records current file');
assert.strictEqual(t.requestBatchCancel(batchState), true, 'first batch cancellation request succeeds');
assert.strictEqual(batchState.cancelled, true, 'batch cancellation flag is set');
assert.strictEqual(t.requestBatchCancel(batchState), false, 'duplicate batch cancellation request is ignored');
assert.strictEqual(t.requestBatchCancel(null), false, 'missing batch state cannot be cancelled');

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
assert.strictEqual(
  t.shouldSkipBatchFile({
    schemaVersion: t.CACHE_SCHEMA_VERSION,
    contentHash: hash,
    settingsHash: t.generationFingerprint(baseSettings),
  }, 'test', baseSettings),
  true,
  'fresh cache entry is skipped during batch',
);
assert.strictEqual(t.shouldSkipBatchFile(null, 'test', baseSettings), false, 'missing cache entry is not skipped');

async function testSummarizeDocumentAnchorSorting() {
  const previousRequestUrlMock = requestUrlMock;
  requestUrlMock = async () =>
    openAiCardsResponse([
      { title: 'Second', anchor: 'second anchor', gist: 'G2', bullets: ['B2'] },
      { title: 'First', anchor: 'first anchor', gist: 'G1', bullets: ['B1'] },
    ]);

  let sections;
  try {
    sections = await t.summarizeDocument(
      'intro\nfirst anchor\nmiddle\nsecond anchor\nend',
      {
        ...baseSettings,
        streaming: false,
        promptLanguage: 'en',
        minCards: 1,
        maxCards: 3,
        maxDocChars: 10000,
      },
      { phase: 'queued', onCancel: () => {}, throwIfCancelled: () => {}, setPhase: () => {} },
    );
  } finally {
    requestUrlMock = previousRequestUrlMock;
  }

  assert.deepStrictEqual(
    sections.map((section) => section.title),
    ['First', 'Second'],
    'summarizeDocument sorts API cards by resolved anchor line',
  );
  assert.deepStrictEqual(
    sections.map((section) => section.startLine),
    [1, 3],
    'summarizeDocument resolves anchor lines from source content',
  );
}

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

// parseSseBuffer: partial line (no trailing newline → stays in rest)
const ssePartial = t.parseSseBuffer('data: {"choices":[{"delta":{"content":"ok"}}]}', openaiExtract);
assert.deepStrictEqual(ssePartial.deltas, [], 'incomplete line yields no deltas');
assert.ok(ssePartial.rest.includes('"ok"'), 'partial line kept in rest');

// parseSseBuffer: multi-event in one chunk
const sseMulti = t.parseSseBuffer(
  'data: {"choices":[{"delta":{"content":"a"}}]}\ndata: {"choices":[{"delta":{"content":"b"}}]}\ndata: {"choices":[{"delta":{"content":"c"}}]}\n',
  openaiExtract,
);
assert.deepStrictEqual(sseMulti.deltas, ['a', 'b', 'c'], 'three events in one chunk');
assert.strictEqual(sseMulti.rest, '', 'nothing left in rest when chunk ends with newline');

// parseSseBuffer: non-data lines are skipped
const sseMixed = t.parseSseBuffer(
  ': comment\nevent: ping\ndata: {"choices":[{"delta":{"content":"x"}}]}\n',
  openaiExtract,
);
assert.deepStrictEqual(sseMixed.deltas, ['x'], 'comment and event lines ignored');

// parseSseBuffer: malformed JSON is silently skipped
const sseBad = t.parseSseBuffer('data: not_json\ndata: {"choices":[{"delta":{"content":"y"}}]}\n', openaiExtract);
assert.deepStrictEqual(sseBad.deltas, ['y'], 'bad JSON line skipped, good line extracted');

// i18n: additional edge cases
assert.strictEqual(
  t.translate({ uiLanguage: 'en' }, 'generationDone', { count: 3, suffix: '' }),
  'Generated 3 sections',
  'variable interpolation with multiple vars',
);
assert.strictEqual(
  t.translate({ uiLanguage: 'zh' }, 'appTitle'),
  '对照阅读笔记',
  'zh translation for appTitle',
);
// missing key fallback chain: should return the key itself
assert.strictEqual(t.translate({ uiLanguage: 'en' }, '__no_such_key__'), '__no_such_key__', 'missing key returns key');

// ── cli.ts: resolveCliPath ──

// Override path: should return the trimmed override immediately
assert.strictEqual(t.resolveCliPath('claude', '  /usr/bin/claude  '), '/usr/bin/claude', 'trims override path');
assert.strictEqual(t.resolveCliPath('claude', '/custom/path'), '/custom/path', 'returns custom path unchanged');

// Empty override: falls back to filesystem search; mock fs.existsSync to control behavior
const fsModule = require('fs');
const origExistsSync = fsModule.existsSync;

// Mock existsSync to pretend a specific path exists
const mockPath = require('path').join(require('os').homedir(), '.local', 'bin', 'claude');
fsModule.existsSync = (p) => p === mockPath;
try {
  const resolved = t.resolveCliPath('claude', '');
  assert.strictEqual(resolved, mockPath, 'resolveCliPath finds binary in mocked ~/.local/bin');
} finally {
  fsModule.existsSync = origExistsSync;
}

// No match: falls back to bare name
fsModule.existsSync = () => false;
try {
  const fallback = t.resolveCliPath('claude', '');
  assert.strictEqual(fallback, 'claude', 'resolveCliPath falls back to bare name when not found');
} finally {
  fsModule.existsSync = origExistsSync;
}

// Wrap the tail in an async runner so module-level tests can include async cases.
(async () => {
  await testCacheManagerMove();
  await testSummarizeDocumentAnchorSorting();
  console.log('modules tests passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
