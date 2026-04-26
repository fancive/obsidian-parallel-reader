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

    console.log('direct module tests passed');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
