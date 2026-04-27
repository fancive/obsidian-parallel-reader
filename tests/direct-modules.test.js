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
