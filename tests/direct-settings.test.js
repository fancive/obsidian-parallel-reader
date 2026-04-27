const { assert, requireBundledModule, cleanup } = require('./direct-test-setup');

(async () => {
  try {
    const settings = await requireBundledModule('src/settings.ts');
    const cards = await requireBundledModule('src/cards.ts');
    const vault = await requireBundledModule('src/vault.ts');

    // ── settings.ts ──
    assert.notStrictEqual(
      settings.generationFingerprint({ ...settings.DEFAULT_SETTINGS, model: 'a' }),
      settings.generationFingerprint({ ...settings.DEFAULT_SETTINGS, model: 'b' }),
    );

    // applyApiProviderPreset: model swap
    const anthropicSettings = { ...settings.DEFAULT_SETTINGS, apiProvider: 'anthropic', model: 'claude-sonnet-4-6' };
    const switchedToOpenAi = settings.applyApiProviderPreset(anthropicSettings, 'openai');
    assert.strictEqual(switchedToOpenAi.apiProvider, 'openai');
    assert.strictEqual(switchedToOpenAi.apiFormat, 'openai-chat');
    assert.strictEqual(switchedToOpenAi.model, 'gpt-5.1');

    const customModelSettings = { ...settings.DEFAULT_SETTINGS, apiProvider: 'anthropic', model: 'my-custom-model' };
    assert.strictEqual(settings.applyApiProviderPreset(customModelSettings, 'openai').model, 'my-custom-model');

    const openaiWithPresetModel = { ...settings.DEFAULT_SETTINGS, apiProvider: 'openai', model: 'gpt-5.1' };
    const switchedToGoogle = settings.applyApiProviderPreset(openaiWithPresetModel, 'google');
    assert.strictEqual(switchedToGoogle.model, 'gemini-3-pro-preview');

    const emptyModelSettings = { ...settings.DEFAULT_SETTINGS, apiProvider: 'anthropic', model: '' };
    assert.strictEqual(settings.applyApiProviderPreset(emptyModelSettings, 'deepseek').model, 'deepseek-chat');

    assert.strictEqual(anthropicSettings.model, 'claude-sonnet-4-6', 'does not mutate input');

    // normalizeCardCount
    assert.strictEqual(settings.normalizeCardCount(5, 10), 5);
    assert.strictEqual(settings.normalizeCardCount(0, 10), 1);
    assert.strictEqual(settings.normalizeCardCount(-5, 10), 1);
    assert.strictEqual(settings.normalizeCardCount(100, 10), 30);
    assert.strictEqual(settings.normalizeCardCount(NaN, 7), 7);
    assert.strictEqual(settings.normalizeCardCount(undefined, 7), 7);
    assert.strictEqual(settings.normalizeCardCount('15', 7), 15);

    // getApiKey
    assert.strictEqual(settings.getApiKey({ ...settings.DEFAULT_SETTINGS, apiKey: 'direct-key' }), 'direct-key');
    assert.strictEqual(settings.getApiKey({ ...settings.DEFAULT_SETTINGS, apiKey: '', apiKeyEnvVar: '' }), '');
    assert.strictEqual(settings.getApiKey({ ...settings.DEFAULT_SETTINGS, apiKey: '  trimmed  ' }), 'trimmed');

    const envVarName = '__PARALLEL_READER_TEST_KEY__';
    process.env[envVarName] = 'env-key-val';
    try {
      assert.strictEqual(settings.getApiKey({ ...settings.DEFAULT_SETTINGS, apiKey: '', apiKeyEnvVar: envVarName }), 'env-key-val');
      assert.strictEqual(settings.getApiKey({ ...settings.DEFAULT_SETTINGS, apiKey: 'direct', apiKeyEnvVar: envVarName }), 'direct');
    } finally {
      delete process.env[envVarName];
    }

    // cacheEntryMatches
    const testContent = 'hello world';
    const testSettings = { ...settings.DEFAULT_SETTINGS };
    const validEntry = {
      schemaVersion: settings.CACHE_SCHEMA_VERSION,
      contentHash: settings.hashContent(testContent),
      settingsHash: settings.generationFingerprint(testSettings),
      cards: [], generatedAt: '2024-01-01T00:00:00.000Z',
    };
    assert.strictEqual(settings.cacheEntryMatches(validEntry, testContent, testSettings), true);
    assert.strictEqual(settings.cacheEntryMatches(null, testContent, testSettings), false);
    assert.strictEqual(settings.cacheEntryMatches({ ...validEntry, contentHash: 'wrong' }, testContent, testSettings), false);
    assert.strictEqual(settings.cacheEntryMatches({ ...validEntry, schemaVersion: 999 }, testContent, testSettings), false);
    assert.strictEqual(settings.cacheEntryMatches(validEntry, 'different content', testSettings), false);

    // ── cards.ts: resolveCardAnchors ──
    const content = 'line0 hello\nline1 world\nline2 anchor here\nline3 end';
    const rawCards = [
      { title: 'A', anchor: 'anchor here', gist: 'gA', bullets: ['b1'] },
      { title: 'B', anchor: 'hello', gist: 'gB', bullets: [] },
      { title: 'C', anchor: 'not_found', gist: 'gC', bullets: [] },
    ];
    const resolved = cards.resolveCardAnchors(content, rawCards);
    assert.strictEqual(resolved[0].title, 'B');
    assert.strictEqual(resolved[0].startLine, 0);
    assert.strictEqual(resolved[1].title, 'A');
    assert.strictEqual(resolved[1].startLine, 2);
    assert.strictEqual(resolved[2].title, 'C');
    assert.ok(resolved[2].startLine < 0);
    assert.deepStrictEqual(cards.resolveCardAnchors('', []), []);
    assert.deepStrictEqual(cards.resolveCardAnchors('content', null), []);
    assert.deepStrictEqual(cards.resolveCardAnchors('content', undefined), []);
    assert.strictEqual(resolved[0].level, 2, 'level defaults to 2');

    // ── vault.ts ──
    assert.strictEqual(vault.normalizeVaultPath('Reading/Articles'), 'Reading/Articles');
    assert.strictEqual(vault.normalizeVaultPath(' Reading / Articles '), 'Reading/Articles');
    assert.strictEqual(vault.normalizeVaultPath('../bad/../path'), 'bad/path');
    assert.strictEqual(vault.normalizeVaultPath(''), '');
    assert.strictEqual(vault.normalizeVaultPath(null), '');
    assert.strictEqual(vault.normalizeVaultPath('a//b///c'), 'a/b/c');

    console.log('direct settings tests passed');
  } finally {
    cleanup();
  }
})().catch((e) => { console.error(e); process.exit(1); });
