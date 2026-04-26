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
    const generation = await requireBundledModule('src/generation.ts');
    const providerParsers = await requireBundledModule('src/provider-parsers.ts');
    const settings = await requireBundledModule('src/settings.ts');
    const streaming = await requireBundledModule('src/streaming.ts');

  const cacheEntry = { generatedAt: '2024-01-01T00:00:00.000Z' };
  const touched = cache.touchCacheEntry(cacheEntry, '2024-06-01T00:00:00.000Z');
  assert.strictEqual(touched.lastAccessedAt, '2024-06-01T00:00:00.000Z', 'direct cache import touches entries');
  assert.strictEqual(cacheEntry.lastAccessedAt, undefined, 'direct cache import keeps cache entries immutable');
  assert.strictEqual(JSON.parse(cache.serializeCacheFile({ 'a.md': { cards: [] } })).version, 1);

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
