const { assert, requireBundledModule, cleanup } = require('./direct-test-setup');

(async () => {
  try {
    const settings = await requireBundledModule('src/settings.ts');
    const base = settings.DEFAULT_SETTINGS;

    // ── stableStringify ──
    assert.strictEqual(settings.stableStringify(42), '42', 'number');
    assert.strictEqual(settings.stableStringify('hi'), '"hi"', 'string');
    assert.strictEqual(settings.stableStringify(null), 'null', 'null');
    assert.strictEqual(settings.stableStringify(true), 'true', 'boolean');
    assert.strictEqual(settings.stableStringify([1, 2]), '[1,2]', 'array');
    assert.strictEqual(settings.stableStringify([]), '[]', 'empty array');
    // Keys sorted alphabetically
    assert.strictEqual(settings.stableStringify({ b: 2, a: 1 }), '{"a":1,"b":2}', 'object keys sorted');
    assert.strictEqual(settings.stableStringify({}), '{}', 'empty object');
    // Nested objects
    assert.strictEqual(
      settings.stableStringify({ z: { b: 2, a: 1 }, a: 3 }),
      '{"a":3,"z":{"a":1,"b":2}}',
      'nested keys sorted',
    );
    // Same data different order produces same string
    assert.strictEqual(
      settings.stableStringify({ x: 1, y: 2 }),
      settings.stableStringify({ y: 2, x: 1 }),
      'key order does not matter',
    );

    // ── isApiBackend ──
    assert.strictEqual(settings.isApiBackend('api'), true, 'api is API backend');
    assert.strictEqual(settings.isApiBackend('anthropic-api'), true, 'anthropic-api is API backend');
    assert.strictEqual(settings.isApiBackend('claude-code'), false, 'claude-code is not API');
    assert.strictEqual(settings.isApiBackend('codex'), false, 'codex is not API');
    assert.strictEqual(settings.isApiBackend(''), false, 'empty is not API');

    // ── getApiFormat ──
    assert.strictEqual(
      settings.getApiFormat({ ...base, apiProvider: 'openai', apiFormat: 'openai-chat' }),
      'openai-chat',
      'explicit format used',
    );
    assert.strictEqual(
      settings.getApiFormat({ ...base, apiProvider: 'anthropic', apiFormat: '' }),
      'anthropic-messages',
      'empty format falls back to preset',
    );
    assert.strictEqual(
      settings.getApiFormat({ ...base, apiProvider: 'google', apiFormat: 'nonexistent-format' }),
      'google-generative-ai',
      'invalid format falls back to preset',
    );

    // ── getApiAuthType ──
    assert.strictEqual(settings.getApiAuthType({ ...base, apiAuthType: 'bearer' }), 'bearer', 'explicit auth type');
    assert.strictEqual(
      settings.getApiAuthType({ ...base, apiProvider: 'anthropic', apiAuthType: 'auto' }),
      'x-api-key',
      'auto falls back to preset',
    );
    assert.strictEqual(
      settings.getApiAuthType({ ...base, apiProvider: 'ollama', apiAuthType: 'auto' }),
      'none',
      'ollama preset has none auth',
    );

    // ── normalizeMaxCacheEntries ──
    assert.strictEqual(settings.normalizeMaxCacheEntries(50), 50, 'normal value');
    assert.strictEqual(settings.normalizeMaxCacheEntries(0), 100, 'zero falls back to default');
    assert.strictEqual(settings.normalizeMaxCacheEntries(-5), 100, 'negative falls back');
    assert.strictEqual(settings.normalizeMaxCacheEntries(NaN), 100, 'NaN falls back');
    assert.strictEqual(settings.normalizeMaxCacheEntries('25'), 25, 'string number coerced');

    // ── hashContent ──
    const h1 = settings.hashContent('hello');
    const h2 = settings.hashContent('hello');
    const h3 = settings.hashContent('world');
    assert.strictEqual(h1, h2, 'same input = same hash');
    assert.notStrictEqual(h1, h3, 'different input = different hash');
    assert.strictEqual(h1.length, 40, 'sha1 hex is 40 chars');

    // ── normalizeSettings edge cases ──
    const normed = settings.normalizeSettings({
      ...base,
      uiLanguage: 'invalid',
      apiProvider: 'nonexistent',
      apiFormat: 'bad',
      apiAuthType: 'bad',
      apiMaxTokens: -1,
      maxDocChars: 500,
      customSystemPrompt: 42,
    });
    assert.strictEqual(normed.uiLanguage, 'auto', 'invalid uiLanguage → auto');
    assert.strictEqual(normed.apiProvider, 'anthropic', 'invalid apiProvider → anthropic');
    assert.strictEqual(normed.apiFormat, 'anthropic-messages', 'invalid apiFormat → preset format');
    assert.strictEqual(normed.apiAuthType, 'auto', 'invalid apiAuthType → auto');
    assert.strictEqual(normed.apiMaxTokens, base.apiMaxTokens, 'invalid apiMaxTokens → default');
    assert.strictEqual(normed.maxDocChars, base.maxDocChars, 'maxDocChars <1000 → default');
    assert.strictEqual(normed.customSystemPrompt, '', 'non-string customSystemPrompt → empty string');

    // ── pruneCacheEntries edge cases ──
    assert.deepStrictEqual(settings.pruneCacheEntries(null, 10), [], 'null cache');
    assert.deepStrictEqual(settings.pruneCacheEntries({}, 10), [], 'empty cache');
    assert.deepStrictEqual(settings.pruneCacheEntries('not-obj', 10), [], 'non-object cache');

    console.log('direct settings extra tests passed');
  } finally {
    cleanup();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
