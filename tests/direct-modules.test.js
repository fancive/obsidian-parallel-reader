const assert = require('assert');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-reader-tests-'));

async function requireBundledModule(relativePath) {
  const entry = path.join(repoRoot, relativePath);
  const outfile = path.join(tempDir, relativePath.replace(/[/.]/g, '_') + '.cjs');
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    plugins: [
      {
        name: 'obsidian-stub',
        setup(build) {
          build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian-stub', namespace: 'stub' }));
          build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
            contents: 'module.exports = { requestUrl: async () => { throw new Error("requestUrl not available in direct module tests"); } };',
            loader: 'js',
          }));
        },
      },
    ],
  });
  return require(outfile);
}

(async () => {
  try {
    const cache = await requireBundledModule('src/cache.ts');
    const cacheManagerModule = await requireBundledModule('src/cache-manager.ts');
    const generation = await requireBundledModule('src/generation.ts');
    const providerParsers = await requireBundledModule('src/provider-parsers.ts');
    const settings = await requireBundledModule('src/settings.ts');
    const streaming = await requireBundledModule('src/streaming.ts');

  const cacheEntry = { generatedAt: '2024-01-01T00:00:00.000Z' };
  const touched = cache.touchCacheEntry(cacheEntry, '2024-06-01T00:00:00.000Z');
  assert.strictEqual(touched.lastAccessedAt, '2024-06-01T00:00:00.000Z', 'direct cache import touches entries');
  assert.strictEqual(cacheEntry.lastAccessedAt, undefined, 'direct cache import keeps cache entries immutable');
  assert.strictEqual(JSON.parse(cache.serializeCacheFile({ 'a.md': { cards: [] } })).version, 1);

  function createFakeAdapter() {
    const files = new Map();
    const dirs = new Set();
    return {
      files,
      dirs,
      writes: [],
      exists: async (filePath) => dirs.has(filePath) || files.has(filePath),
      mkdir: async (filePath) => {
        dirs.add(filePath);
      },
      read: async (filePath) => {
        if (!files.has(filePath)) throw new Error('not found');
        return files.get(filePath);
      },
      write: async (filePath, content) => {
        files.set(filePath, content);
        return files.get(filePath);
      },
    };
  }

  const adapter = createFakeAdapter();
  const manager = new cacheManagerModule.CacheManager(adapter, '.obsidian', 'parallel-reader', () => ({
    ...settings.DEFAULT_SETTINGS,
    maxCacheEntries: 2,
  }));
  adapter.files.set(
    manager.filePath(),
    JSON.stringify({
      version: 1,
      entries: {
        'old.md': { generatedAt: '2024-01-01T00:00:00.000Z', cards: [] },
        'fresh.md': { generatedAt: '2024-01-02T00:00:00.000Z', cards: [] },
        'touched.md': {
          generatedAt: '2024-01-03T00:00:00.000Z',
          lastAccessedAt: '2024-02-01T00:00:00.000Z',
          cards: [],
        },
      },
    }),
  );
  await manager.load();
  assert.strictEqual(manager.cache['old.md'], undefined, 'CacheManager.load prunes old entries');
  assert.ok(adapter.files.get(manager.filePath()).includes('fresh.md'), 'CacheManager.load persists prune results');

  const touchedEntry = await manager.touch('fresh.md');
  assert.ok(touchedEntry.lastAccessedAt, 'CacheManager.touch updates existing entries');
  await manager.flush();
  assert.ok(JSON.parse(adapter.files.get(manager.filePath())).entries['fresh.md'].lastAccessedAt);

  assert.strictEqual(
    await manager.replaceCards('fresh.md', [{ title: 'New', anchor: 'A', gist: 'G', bullets: ['B'], level: 2, startLine: 1 }]),
    true,
    'CacheManager.replaceCards updates existing entries',
  );
  assert.strictEqual(JSON.parse(adapter.files.get(manager.filePath())).entries['fresh.md'].cards[0].title, 'New');

  await manager.delete('fresh.md');
  assert.strictEqual(manager.cache['fresh.md'], undefined, 'CacheManager.delete removes entries');

  manager.cache = { 'clear.md': { generatedAt: '2024-01-04T00:00:00.000Z', cards: [] } };
  await manager.save();
  assert.ok(adapter.files.get(manager.filePath()).includes('clear.md'), 'CacheManager.save persists current cache');
  await manager.clear();
  assert.deepStrictEqual(manager.cache, {}, 'CacheManager.clear resets cache state');

  // Cache pruning interleaved with put: oldest entry gets pruned
  const pruneAdapter = createFakeAdapter();
  const pruneManager = new cacheManagerModule.CacheManager(pruneAdapter, '.obsidian', 'parallel-reader', () => ({
    ...settings.DEFAULT_SETTINGS,
    maxCacheEntries: 2,
  }));
  await pruneManager.load();
  // Seed with entries that have distinct timestamps so pruning is deterministic
  pruneManager.cache = {
    'old.md': { schemaVersion: 2, contentHash: 'a', settingsHash: 'a', cards: [], generatedAt: '2024-01-01T00:00:00.000Z', lastAccessedAt: '2024-01-01T00:00:00.000Z' },
    'mid.md': { schemaVersion: 2, contentHash: 'b', settingsHash: 'b', cards: [], generatedAt: '2024-06-01T00:00:00.000Z', lastAccessedAt: '2024-06-01T00:00:00.000Z' },
  };
  // Put a third entry — cache now has 3 entries, save triggers prune to max=2
  await pruneManager.put('new.md', 'new content', [{ title: 'N', anchor: 'n', gist: 'g', bullets: [] }], settings.DEFAULT_SETTINGS);
  assert.strictEqual(Object.keys(pruneManager.cache).length, 2, 'cache pruned to max entries after put');
  assert.ok(pruneManager.cache['new.md'], 'newest entry survives pruning');
  assert.ok(pruneManager.cache['mid.md'], 'middle entry survives pruning');
  assert.strictEqual(pruneManager.cache['old.md'], undefined, 'oldest entry pruned by timestamp');

  // Verify the persisted file reflects the pruned state
  const persistedPrune = JSON.parse(pruneAdapter.files.get(pruneManager.filePath()));
  assert.ok(persistedPrune.entries['new.md'], 'newest entry persisted after pruning');
  assert.strictEqual(persistedPrune.entries['old.md'], undefined, 'oldest entry not in persisted cache');

  // --- CacheManager.get() ---
  assert.strictEqual(pruneManager.get('new.md').cards[0].title, 'N', 'CacheManager.get returns existing entry');
  assert.strictEqual(pruneManager.get('nonexistent.md'), null, 'CacheManager.get returns null for missing entry');

  // --- CacheManager.move() ---
  const moveAdapter = createFakeAdapter();
  const moveManager = new cacheManagerModule.CacheManager(moveAdapter, '.obsidian', 'parallel-reader', () => settings.DEFAULT_SETTINGS);
  await moveManager.load();
  moveManager.cache = {
    'a.md': { schemaVersion: 2, contentHash: 'a', settingsHash: 'a', cards: [{ title: 'A', anchor: 'a', gist: 'g', bullets: [] }], generatedAt: '2024-01-01T00:00:00.000Z' },
    'b.md': { schemaVersion: 2, contentHash: 'b', settingsHash: 'b', cards: [], generatedAt: '2024-01-02T00:00:00.000Z' },
  };
  await moveManager.save();

  const moveResult = await moveManager.move('a.md', 'renamed.md');
  assert.strictEqual(moveResult, true, 'CacheManager.move returns true on success');
  assert.strictEqual(moveManager.get('a.md'), null, 'CacheManager.move removes old path');
  assert.strictEqual(moveManager.get('renamed.md').cards[0].title, 'A', 'CacheManager.move preserves entry at new path');
  assert.strictEqual(await moveManager.move('renamed.md', 'b.md'), false, 'CacheManager.move rejects when destination exists');
  assert.strictEqual(await moveManager.move('b.md', 'b.md'), true, 'CacheManager.move same-path returns true if entry exists');
  assert.strictEqual(await moveManager.move('gone.md', 'gone.md'), false, 'CacheManager.move same-path returns false if missing');
  assert.strictEqual(await moveManager.move('gone.md', 'new-gone.md'), false, 'CacheManager.move returns false for missing source');
  assert.strictEqual(await moveManager.move('', 'dest.md'), false, 'CacheManager.move rejects empty oldPath');
  assert.strictEqual(await moveManager.move('src.md', ''), false, 'CacheManager.move rejects empty newPath');
  assert.strictEqual(await moveManager.move('  ', 'dest.md'), false, 'CacheManager.move rejects whitespace oldPath');

  // --- CacheManager.readFile() with corrupt JSON ---
  const corruptAdapter = createFakeAdapter();
  const corruptManager = new cacheManagerModule.CacheManager(corruptAdapter, '.obsidian', 'parallel-reader', () => settings.DEFAULT_SETTINGS);
  corruptAdapter.files.set(corruptManager.filePath(), '{ invalid json !!!');
  const corruptResult = await corruptManager.readFile();
  assert.deepStrictEqual(corruptResult, {}, 'CacheManager.readFile returns empty object for corrupt JSON');

  // readFile with valid JSON but no entries field
  const noEntriesAdapter = createFakeAdapter();
  const noEntriesManager = new cacheManagerModule.CacheManager(noEntriesAdapter, '.obsidian', 'parallel-reader', () => settings.DEFAULT_SETTINGS);
  noEntriesAdapter.files.set(noEntriesManager.filePath(), JSON.stringify({ version: 1 }));
  const noEntriesResult = await noEntriesManager.readFile();
  assert.deepStrictEqual(noEntriesResult, {}, 'CacheManager.readFile returns empty object when no entries field');

  // --- CacheManager.pruneIfNeeded() ---
  const pruneNeededAdapter = createFakeAdapter();
  const pruneNeededManager = new cacheManagerModule.CacheManager(pruneNeededAdapter, '.obsidian', 'parallel-reader', () => ({
    ...settings.DEFAULT_SETTINGS,
    maxCacheEntries: 1,
  }));
  await pruneNeededManager.load();
  pruneNeededManager.cache = {
    'old.md': { schemaVersion: 2, contentHash: 'a', settingsHash: 'a', cards: [], generatedAt: '2024-01-01T00:00:00.000Z', lastAccessedAt: '2024-01-01T00:00:00.000Z' },
    'new.md': { schemaVersion: 2, contentHash: 'b', settingsHash: 'b', cards: [], generatedAt: '2024-06-01T00:00:00.000Z', lastAccessedAt: '2024-06-01T00:00:00.000Z' },
  };
  const pruneIfResult = await pruneNeededManager.pruneIfNeeded();
  assert.strictEqual(pruneIfResult.length, 1, 'CacheManager.pruneIfNeeded returns removed keys');
  assert.strictEqual(pruneIfResult[0], 'old.md', 'CacheManager.pruneIfNeeded removes oldest');
  assert.strictEqual(Object.keys(pruneNeededManager.cache).length, 1, 'CacheManager.pruneIfNeeded prunes to limit');

  // pruneIfNeeded with nothing to prune
  const noPruneAdapter = createFakeAdapter();
  const noPruneManager = new cacheManagerModule.CacheManager(noPruneAdapter, '.obsidian', 'parallel-reader', () => ({
    ...settings.DEFAULT_SETTINGS,
    maxCacheEntries: 100,
  }));
  await noPruneManager.load();
  noPruneManager.cache = {
    'only.md': { schemaVersion: 2, contentHash: 'a', settingsHash: 'a', cards: [], generatedAt: '2024-01-01T00:00:00.000Z' },
  };
  const noPruneResult = await noPruneManager.pruneIfNeeded();
  assert.strictEqual(noPruneResult.length, 0, 'CacheManager.pruneIfNeeded returns empty when nothing to prune');

  // --- CacheManager.replaceCards() with missing entry ---
  assert.strictEqual(
    await pruneNeededManager.replaceCards('nonexistent.md', []),
    false,
    'CacheManager.replaceCards returns false for missing entry',
  );

  // --- CacheManager.scheduleSave() + flush() ---
  const scheduleAdapter = createFakeAdapter();
  const scheduleManager = new cacheManagerModule.CacheManager(scheduleAdapter, '.obsidian', 'parallel-reader', () => settings.DEFAULT_SETTINGS);
  await scheduleManager.load();
  scheduleManager.cache = { 'sched.md': { schemaVersion: 2, contentHash: 'x', settingsHash: 'x', cards: [], generatedAt: '2024-01-01T00:00:00.000Z' } };
  scheduleManager.scheduleSave(50000);
  await scheduleManager.flush();
  const flushedData = JSON.parse(scheduleAdapter.files.get(scheduleManager.filePath()));
  assert.ok(flushedData.entries['sched.md'], 'CacheManager.flush persists scheduled save immediately');

  // flush when not dirty should be a no-op
  scheduleAdapter.files.delete(scheduleManager.filePath());
  await scheduleManager.flush();
  assert.strictEqual(scheduleAdapter.files.has(scheduleManager.filePath()), false, 'CacheManager.flush is no-op when not dirty');

  assert.strictEqual(
    generation.cancellationNoticeKey({ backend: 'api' }, { phase: 'generating' }),
    'cancelRequestedApiInFlight',
    'direct generation import exposes API cancellation semantics',
  );
  assert.strictEqual(
    generation.cancellationNoticeKey({ backend: 'codex' }, { phase: 'generating' }),
    'cancelRequested',
    'direct generation import exposes CLI cancellation semantics',
  );

  const providerCardsJson = JSON.stringify({ cards: [{ title: 'T', anchor: 'A', gist: 'G', bullets: ['B'] }] });
  assert.strictEqual(
    providerParsers.textFromOpenAiChatResponse({ choices: [{ message: { content: [{ text: providerCardsJson }] } }] }),
    providerCardsJson,
    'direct provider parser import extracts OpenAI Chat text',
  );
  assert.strictEqual(
    providerParsers.textFromAnthropicMessagesResponse({ content: [{ type: 'text', text: providerCardsJson }] }),
    providerCardsJson,
    'direct provider parser import extracts Anthropic text',
  );
  assert.strictEqual(
    providerParsers.textFromOpenAiResponsesResponse({
      output: [{ content: [{ type: 'output_text', text: providerCardsJson }] }],
    }),
    providerCardsJson,
    'direct provider parser import extracts OpenAI Responses text',
  );
  assert.strictEqual(
    providerParsers.textFromGoogleGenerativeAiResponse({
      candidates: [{ content: { parts: [{ text: providerCardsJson }] } }],
    }),
    providerCardsJson,
    'direct provider parser import extracts Gemini text',
  );
  assert.deepStrictEqual(
    providerParsers.cardsFromAnthropicToolUse({
      content: [{ type: 'tool_use', name: 'record_parallel_reader_cards', input: JSON.parse(providerCardsJson) }],
    }),
    [{ title: 'T', anchor: 'A', gist: 'G', bullets: ['B'] }],
    'direct provider parser import extracts Anthropic tool-use cards',
  );

  // --- Provider parser edge cases ---

  // textFromProviderContent: string input
  assert.strictEqual(providerParsers.textFromProviderContent('hello'), 'hello', 'textFromProviderContent handles string');
  // textFromProviderContent: object with output_text
  assert.strictEqual(providerParsers.textFromProviderContent({ output_text: 'ot' }), 'ot', 'textFromProviderContent handles output_text object');
  // textFromProviderContent: array with mixed items
  assert.strictEqual(providerParsers.textFromProviderContent(['a', { text: 'b' }, { output_text: 'c' }, 42]), 'abc', 'textFromProviderContent handles mixed array');
  // textFromProviderContent: null/undefined
  assert.strictEqual(providerParsers.textFromProviderContent(null), '', 'textFromProviderContent handles null');
  assert.strictEqual(providerParsers.textFromProviderContent(undefined), '', 'textFromProviderContent handles undefined');
  // textFromProviderContent: object with neither text nor output_text
  assert.strictEqual(providerParsers.textFromProviderContent({ foo: 'bar' }), '', 'textFromProviderContent handles object with no text fields');

  // textFromOpenAiChatResponse: empty choices
  assert.strictEqual(providerParsers.textFromOpenAiChatResponse({}), '', 'OpenAI Chat parser handles empty response');
  assert.strictEqual(providerParsers.textFromOpenAiChatResponse({ choices: [] }), '', 'OpenAI Chat parser handles empty choices');
  // textFromOpenAiChatResponse: text fallback (old completions format)
  assert.strictEqual(providerParsers.textFromOpenAiChatResponse({ choices: [{ text: 'legacy' }] }), 'legacy', 'OpenAI Chat parser handles legacy text field');

  // textFromAnthropicMessagesResponse: empty content
  assert.strictEqual(providerParsers.textFromAnthropicMessagesResponse({}), '', 'Anthropic parser handles empty response');
  assert.strictEqual(providerParsers.textFromAnthropicMessagesResponse({ content: [] }), '', 'Anthropic parser handles empty content');
  // textFromAnthropicMessagesResponse: multiple content blocks
  assert.strictEqual(
    providerParsers.textFromAnthropicMessagesResponse({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }),
    'ab',
    'Anthropic parser concatenates multiple text blocks',
  );

  // textFromGoogleGenerativeAiResponse: empty candidates
  assert.strictEqual(providerParsers.textFromGoogleGenerativeAiResponse({}), '', 'Gemini parser handles empty response');
  assert.strictEqual(providerParsers.textFromGoogleGenerativeAiResponse({ candidates: [] }), '', 'Gemini parser handles empty candidates');
  assert.strictEqual(
    providerParsers.textFromGoogleGenerativeAiResponse({ candidates: [{ content: {} }] }),
    '',
    'Gemini parser handles candidate with no parts',
  );

  // textFromOpenAiResponsesResponse: output_text shortcut
  assert.strictEqual(providerParsers.textFromOpenAiResponsesResponse({ output_text: 'direct' }), 'direct', 'OpenAI Responses parser handles output_text shortcut');
  // textFromOpenAiResponsesResponse: nested content with type output_text
  assert.strictEqual(
    providerParsers.textFromOpenAiResponsesResponse({ output: [{ content: [{ type: 'output_text', content: 'nested' }] }] }),
    'nested',
    'OpenAI Responses parser handles nested output_text content',
  );
  // textFromOpenAiResponsesResponse: empty output
  assert.strictEqual(providerParsers.textFromOpenAiResponsesResponse({}), '', 'OpenAI Responses parser handles empty response');

  // cardsFromAnthropicToolUse: no tool_use block
  assert.strictEqual(providerParsers.cardsFromAnthropicToolUse({ content: [{ type: 'text', text: 'hello' }] }), null, 'Anthropic tool-use returns null when no tool_use block');
  // cardsFromAnthropicToolUse: wrong tool name
  assert.strictEqual(providerParsers.cardsFromAnthropicToolUse({ content: [{ type: 'tool_use', name: 'other_tool', input: {} }] }), null, 'Anthropic tool-use returns null for wrong tool name');
  // cardsFromAnthropicToolUse: no content array
  assert.strictEqual(providerParsers.cardsFromAnthropicToolUse({}), null, 'Anthropic tool-use returns null for missing content');

  assert.notStrictEqual(
    settings.generationFingerprint({ ...settings.DEFAULT_SETTINGS, model: 'a' }),
    settings.generationFingerprint({ ...settings.DEFAULT_SETTINGS, model: 'b' }),
    'direct settings import exposes generation fingerprinting',
  );

  // applyApiProviderPreset: model swap when switching providers
  const anthropicSettings = { ...settings.DEFAULT_SETTINGS, apiProvider: 'anthropic', model: 'claude-sonnet-4-6' };
  const switchedToOpenAi = settings.applyApiProviderPreset(anthropicSettings, 'openai');
  assert.strictEqual(switchedToOpenAi.apiProvider, 'openai', 'provider switched to openai');
  assert.strictEqual(switchedToOpenAi.apiFormat, 'openai-chat', 'format updated for openai');
  assert.strictEqual(switchedToOpenAi.model, 'gpt-5.1', 'model swapped to openai preset model');

  // Keep custom model when switching providers
  const customModelSettings = { ...settings.DEFAULT_SETTINGS, apiProvider: 'anthropic', model: 'my-custom-model' };
  const switchedKeepModel = settings.applyApiProviderPreset(customModelSettings, 'openai');
  assert.strictEqual(switchedKeepModel.model, 'my-custom-model', 'custom model preserved when switching providers');

  // Swap model when current model matches previous preset's default
  const openaiWithPresetModel = { ...settings.DEFAULT_SETTINGS, apiProvider: 'openai', model: 'gpt-5.1' };
  const switchedToGoogle = settings.applyApiProviderPreset(openaiWithPresetModel, 'google');
  assert.strictEqual(switchedToGoogle.model, 'gemini-3-pro-preview', 'model swapped when it matched previous preset');
  assert.strictEqual(switchedToGoogle.apiFormat, 'google-generative-ai', 'format updated for google');

  // Empty model triggers swap
  const emptyModelSettings = { ...settings.DEFAULT_SETTINGS, apiProvider: 'anthropic', model: '' };
  const switchedFromEmpty = settings.applyApiProviderPreset(emptyModelSettings, 'deepseek');
  assert.strictEqual(switchedFromEmpty.model, 'deepseek-chat', 'empty model triggers swap to preset default');

  // Does not mutate original settings
  assert.strictEqual(anthropicSettings.model, 'claude-sonnet-4-6', 'applyApiProviderPreset does not mutate input');
  assert.strictEqual(anthropicSettings.apiProvider, 'anthropic', 'original provider unchanged');

  // --- parseSseBuffer unit tests ---
  const openAiExtractor = streaming.deltaExtractorForFormat('openai-chat');
  const anthropicExtractor = streaming.deltaExtractorForFormat('anthropic-messages');

  // deltaExtractorForFormat returns correct extractors
  assert.ok(openAiExtractor, 'deltaExtractorForFormat returns extractor for openai-chat');
  assert.ok(anthropicExtractor, 'deltaExtractorForFormat returns extractor for anthropic-messages');
  assert.strictEqual(streaming.deltaExtractorForFormat('unknown-format'), null, 'deltaExtractorForFormat returns null for unknown');
  assert.strictEqual(streaming.deltaExtractorForFormat('google-generative-ai'), null, 'deltaExtractorForFormat returns null for non-streaming format');

  // OpenAI delta extractor
  assert.strictEqual(openAiExtractor({ choices: [{ delta: { content: 'hello' } }] }), 'hello', 'openai extractor gets content');
  assert.strictEqual(openAiExtractor({ choices: [{ delta: {} }] }), '', 'openai extractor handles missing content');
  assert.strictEqual(openAiExtractor({ choices: [] }), '', 'openai extractor handles empty choices');
  assert.strictEqual(openAiExtractor({}), '', 'openai extractor handles empty json');

  // Anthropic delta extractor
  assert.strictEqual(anthropicExtractor({ type: 'content_block_delta', delta: { text: 'world' } }), 'world', 'anthropic extractor gets text');
  assert.strictEqual(anthropicExtractor({ type: 'content_block_start' }), '', 'anthropic extractor ignores non-delta events');
  assert.strictEqual(anthropicExtractor({ type: 'content_block_delta', delta: {} }), '', 'anthropic extractor handles empty delta');
  assert.strictEqual(anthropicExtractor({}), '', 'anthropic extractor handles empty json');

  // parseSseBuffer: basic single event
  const singleEvent = streaming.parseSseBuffer('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', openAiExtractor);
  assert.deepStrictEqual(singleEvent.deltas, ['hi'], 'parseSseBuffer extracts single delta');
  assert.strictEqual(singleEvent.rest, '', 'parseSseBuffer returns empty rest after complete event');

  // parseSseBuffer: multiple events
  const multiEvent = streaming.parseSseBuffer(
    'data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: {"choices":[{"delta":{"content":"b"}}]}\n\n',
    openAiExtractor,
  );
  assert.deepStrictEqual(multiEvent.deltas, ['a', 'b'], 'parseSseBuffer extracts multiple deltas');

  // parseSseBuffer: incomplete buffer
  const incomplete = streaming.parseSseBuffer('data: {"choices":[{"delta":{"content":"partial"}}]}', openAiExtractor);
  assert.deepStrictEqual(incomplete.deltas, [], 'parseSseBuffer returns no deltas for incomplete event');
  assert.ok(incomplete.rest.length > 0, 'parseSseBuffer returns incomplete data as rest');

  // parseSseBuffer: [DONE] sentinel
  const withDone = streaming.parseSseBuffer('data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n', openAiExtractor);
  assert.deepStrictEqual(withDone.deltas, ['x'], 'parseSseBuffer ignores [DONE] sentinel');

  // parseSseBuffer: non-data lines (comments, event types)
  const withComments = streaming.parseSseBuffer(': keep-alive\nevent: message\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\n', openAiExtractor);
  assert.deepStrictEqual(withComments.deltas, ['ok'], 'parseSseBuffer skips comment and event lines');

  // parseSseBuffer: CRLF line endings
  const crlfEvent = streaming.parseSseBuffer('data: {"choices":[{"delta":{"content":"crlf"}}]}\r\n\r\n', openAiExtractor);
  assert.deepStrictEqual(crlfEvent.deltas, ['crlf'], 'parseSseBuffer handles CRLF line endings');

  // parseSseBuffer: multi-line data
  const multiLine = streaming.parseSseBuffer('data: {"choices":[{"delta":\ndata: {"content":"split"}}]}\n\n', openAiExtractor);
  assert.deepStrictEqual(multiLine.deltas, ['split'], 'parseSseBuffer joins multi-line data fields');

  // parseSseBuffer: malformed JSON
  const malformed = streaming.parseSseBuffer('data: not-json\n\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\n', openAiExtractor);
  assert.deepStrictEqual(malformed.deltas, ['ok'], 'parseSseBuffer skips malformed JSON events');

  // parseSseBuffer: Anthropic format
  const anthropicEvent = streaming.parseSseBuffer(
    'data: {"type":"content_block_delta","delta":{"text":"ant"}}\n\ndata: {"type":"message_stop"}\n\n',
    anthropicExtractor,
  );
  assert.deepStrictEqual(anthropicEvent.deltas, ['ant'], 'parseSseBuffer works with Anthropic format');

  // parseSseBuffer: data: with no space after colon
  const noSpaceData = streaming.parseSseBuffer('data:{"choices":[{"delta":{"content":"ns"}}]}\n\n', openAiExtractor);
  assert.deepStrictEqual(noSpaceData.deltas, ['ns'], 'parseSseBuffer handles data: without trailing space');

  // parseSseBuffer: empty buffer
  const emptyBuf = streaming.parseSseBuffer('', openAiExtractor);
  assert.deepStrictEqual(emptyBuf.deltas, [], 'parseSseBuffer handles empty buffer');
  assert.strictEqual(emptyBuf.rest, '', 'parseSseBuffer returns empty rest for empty buffer');

  function trackedSignal() {
    const controller = new AbortController();
    const signal = controller.signal;
    let activeListeners = 0;
    const addEventListener = signal.addEventListener.bind(signal);
    const removeEventListener = signal.removeEventListener.bind(signal);
    signal.addEventListener = (type, listener, options) => {
      if (type === 'abort') activeListeners++;
      return addEventListener(type, listener, options);
    };
    signal.removeEventListener = (type, listener, options) => {
      if (type === 'abort') activeListeners--;
      return removeEventListener(type, listener, options);
    };
    return { controller, signal, activeListeners: () => activeListeners };
  }

  function streamingBody(text) {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(text));
        controller.close();
      },
    });
  }

  const originalFetch = globalThis.fetch;
  try {
    const success = trackedSignal();
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      body: streamingBody('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'),
      text: async () => '',
    });
    await streaming.streamingFetch(
      'https://example.test',
      {},
      {},
      streaming.deltaExtractorForFormat('openai-chat'),
      undefined,
      success.signal,
      { streamingTimeoutMs: 1000 },
    );
    assert.strictEqual(success.activeListeners(), 0, 'streamingFetch removes abort listener after success');

    const httpError = trackedSignal();
    globalThis.fetch = async () => ({ ok: false, status: 500, body: null, text: async () => 'bad' });
    await assert.rejects(
      () =>
        streaming.streamingFetch(
          'https://example.test',
          {},
          {},
          streaming.deltaExtractorForFormat('openai-chat'),
          undefined,
          httpError.signal,
          { streamingTimeoutMs: 1000 },
        ),
      /HTTP 500|API returned HTTP 500/,
      'streamingFetch rejects HTTP errors',
    );
    assert.strictEqual(httpError.activeListeners(), 0, 'streamingFetch removes abort listener after HTTP error');

    const timeout = trackedSignal();
    globalThis.fetch = async () => new Promise(() => {});
    await assert.rejects(
      () =>
        streaming.streamingFetch(
          'https://example.test',
          {},
          {},
          streaming.deltaExtractorForFormat('openai-chat'),
          undefined,
          timeout.signal,
          { streamingTimeoutMs: 1 },
        ),
      /Streaming timed out after 1ms/,
      'streamingFetch rejects on timeout',
    );
    assert.strictEqual(timeout.activeListeners(), 0, 'streamingFetch removes abort listener after timeout');

    // Abort before fetch starts (pre-aborted signal)
    const preAborted = trackedSignal();
    preAborted.controller.abort();
    globalThis.fetch = async (_url, opts) => {
      if (opts?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      throw new Error('should not reach');
    };
    await assert.rejects(
      () =>
        streaming.streamingFetch(
          'https://example.test',
          {},
          {},
          streaming.deltaExtractorForFormat('openai-chat'),
          undefined,
          preAborted.signal,
          { streamingTimeoutMs: 5000 },
        ),
      /abort/i,
      'streamingFetch rejects when signal is pre-aborted',
    );
    assert.strictEqual(preAborted.activeListeners(), 0, 'streamingFetch cleans up listeners on pre-aborted signal');

    // Abort during read (signal aborted while reading body)
    const abortDuringRead = trackedSignal();
    globalThis.fetch = async (_url, opts) => {
      const fetchSignal = opts?.signal;
      const stream = new ReadableStream({
        async pull(ctrl) {
          const encoder = new TextEncoder();
          // First chunk succeeds
          ctrl.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'));
          // Abort after first chunk
          abortDuringRead.controller.abort();
          // Wait a tick so the abort propagates
          await new Promise((r) => setTimeout(r, 5));
          if (fetchSignal?.aborted) {
            ctrl.error(new DOMException('The operation was aborted.', 'AbortError'));
            return;
          }
          ctrl.close();
        },
      });
      return { ok: true, status: 200, body: stream, text: async () => '' };
    };
    await assert.rejects(
      () =>
        streaming.streamingFetch(
          'https://example.test',
          {},
          {},
          streaming.deltaExtractorForFormat('openai-chat'),
          undefined,
          abortDuringRead.signal,
          { streamingTimeoutMs: 5000 },
        ),
      /abort/i,
      'streamingFetch rejects when signal is aborted during read',
    );
    assert.strictEqual(abortDuringRead.activeListeners(), 0, 'streamingFetch cleans up listeners after mid-read abort');
  } finally {
    globalThis.fetch = originalFetch;
  }

    console.log('direct module tests passed');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
