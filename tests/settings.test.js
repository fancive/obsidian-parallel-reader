const { assert, t, baseSettings } = require('./test-setup');

// modelForApi strips provider prefix
assert.strictEqual(t.modelForApi({ ...baseSettings, model: 'openai/gpt-5.1' }), 'gpt-5.1', 'strip openai prefix');
assert.strictEqual(t.modelForApi({ ...baseSettings, model: 'gpt-5.1' }), 'gpt-5.1', 'no prefix pass-through');
assert.throws(() => t.modelForApi({ ...baseSettings, model: '' }), /Model/, 'empty model throws');

// getApiBaseUrl
assert.strictEqual(
  t.getApiBaseUrl({ ...baseSettings, apiBaseUrl: 'https://custom.ai/v1/' }),
  'https://custom.ai/v1',
  'strips trailing slash',
);
assert.throws(
  () => t.getApiBaseUrl({ ...baseSettings, apiProvider: 'custom-openai', apiBaseUrl: '' }),
  /Custom provider/,
  'custom provider without url throws',
);

// generationFingerprint stability
const fp1 = t.generationFingerprint(baseSettings);
const fp2 = t.generationFingerprint({ ...baseSettings });
assert.strictEqual(fp1, fp2, 'same settings = same fingerprint');
assert.notStrictEqual(
  fp1,
  t.generationFingerprint({ ...baseSettings, model: 'other' }),
  'non-codex backend: different model = different fp',
);

// Codex backend: model is ignored by fingerprint (codex uses its own config)
{
  const codexA = t.generationFingerprint({ ...baseSettings, backend: 'codex', model: 'gpt-5-codex' });
  const codexB = t.generationFingerprint({ ...baseSettings, backend: 'codex', model: 'claude-sonnet-4-6' });
  assert.strictEqual(codexA, codexB, 'codex backend: model change does NOT affect fingerprint');
  // But other fields still affect codex fingerprint
  assert.notStrictEqual(
    codexA,
    t.generationFingerprint({ ...baseSettings, backend: 'codex', model: 'gpt-5-codex', minCards: 999 }),
    'codex backend: other settings still affect fingerprint',
  );
}
assert.notStrictEqual(
  fp1,
  t.generationFingerprint({ ...baseSettings, apiMaxTokens: 8192 }),
  'different tokens = different fp',
);
assert.strictEqual(t.normalizeStreamingTimeoutMs('30000'), 30000, 'streaming timeout accepts numeric strings');
assert.strictEqual(t.normalizeStreamingTimeoutMs(999), 120000, 'streaming timeout below minimum falls back');
assert.strictEqual(t.normalizeStreamingTimeoutMs('bad'), 120000, 'streaming timeout rejects non-numeric values');
assert.strictEqual(
  t.normalizeSettings({ ...baseSettings, streamingTimeoutMs: 500 }).streamingTimeoutMs,
  120000,
  'normalizeSettings protects invalid streaming timeout values',
);

// normalizeSettings does not mutate its input
const settingsInput = { ...baseSettings, streamingTimeoutMs: 500, minCards: -1, maxCards: 999 };
const settingsInputCopy = JSON.parse(JSON.stringify(settingsInput));
const normalized = t.normalizeSettings(settingsInput);
assert.deepStrictEqual(settingsInput, settingsInputCopy, 'normalizeSettings does not mutate input object');
assert.notStrictEqual(normalized, settingsInput, 'normalizeSettings returns a new object');
assert.strictEqual(normalized.minCards, 1, 'normalizeSettings clamps minCards');
assert.strictEqual(normalized.maxCards, 30, 'normalizeSettings clamps maxCards to max 30');

// cacheEntryMatches
const crypto = require('crypto');
const hash = crypto.createHash('sha1').update('test', 'utf8').digest('hex');
assert.strictEqual(
  t.cacheEntryMatches(
    {
      schemaVersion: t.CACHE_SCHEMA_VERSION,
      contentHash: hash,
      settingsHash: t.generationFingerprint(baseSettings),
    },
    'test',
    baseSettings,
  ),
  true,
  'matching entry returns true',
);
assert.strictEqual(t.cacheEntryMatches(null, 'test', baseSettings), false, 'null entry returns false');
assert.strictEqual(
  t.shouldSkipBatchFile(
    {
      schemaVersion: t.CACHE_SCHEMA_VERSION,
      contentHash: hash,
      settingsHash: t.generationFingerprint(baseSettings),
    },
    'test',
    baseSettings,
  ),
  true,
  'fresh cache entry is skipped during batch',
);
assert.strictEqual(t.shouldSkipBatchFile(null, 'test', baseSettings), false, 'missing cache entry is not skipped');

// normalizeCardCount: cap to 30, fall back on invalid
assert.strictEqual(t.normalizeCardCount(50, 5), 30, 'card count over 30 is capped');
assert.strictEqual(t.normalizeCardCount(0, 5), 1, 'card count 0 floors to 1');
assert.strictEqual(t.normalizeCardCount(-1, 5), 1, 'negative card count floors to 1');
assert.strictEqual(t.normalizeCardCount('bad', 5), 5, 'non-numeric card count falls back to default');
assert.strictEqual(t.normalizeCardCount('15', 5), 15, 'numeric string accepted');

// normalizeCliTimeoutMs (mirrors normalizeStreamingTimeoutMs)
assert.strictEqual(t.normalizeCliTimeoutMs('60000'), 60000, 'cli timeout accepts numeric strings');
assert.strictEqual(t.normalizeCliTimeoutMs(999), 120000, 'cli timeout below minimum falls back to default');
assert.strictEqual(t.normalizeCliTimeoutMs('bad'), 120000, 'cli timeout rejects non-numeric values');
assert.strictEqual(
  t.normalizeSettings({ ...baseSettings, cliTimeoutMs: 500 }).cliTimeoutMs,
  120000,
  'normalizeSettings protects invalid cli timeout values',
);

// normalizeCliIdleTimeoutMs: 0 means disabled, anything below MIN coerces to 0, valid passes through
assert.strictEqual(t.normalizeCliIdleTimeoutMs(0), 0, 'idle timeout 0 stays disabled');
assert.strictEqual(t.normalizeCliIdleTimeoutMs(45000), 45000, 'idle timeout valid value passes through');
assert.strictEqual(t.normalizeCliIdleTimeoutMs('30000'), 30000, 'idle timeout numeric string accepted');
assert.strictEqual(t.normalizeCliIdleTimeoutMs(500), 0, 'idle timeout below 1000ms disables (treats as off)');
assert.strictEqual(t.normalizeCliIdleTimeoutMs(-1), 0, 'idle timeout negative coerces to 0');
assert.strictEqual(t.normalizeCliIdleTimeoutMs('bad'), 0, 'idle timeout non-numeric coerces to 0');
assert.strictEqual(
  t.normalizeSettings({ ...baseSettings, cliIdleTimeoutMs: 250 }).cliIdleTimeoutMs,
  0,
  'normalizeSettings disables sub-minimum idle timeout',
);

// applyApiProviderPreset clears credentials but keeps preset baseUrl (security: prevent cross-provider key leak)
{
  const previous = {
    ...baseSettings,
    apiProvider: 'anthropic',
    apiKey: 'sk-ant-secret',
    apiHeaders: 'Authorization: Bearer leaked',
    apiBaseUrl: 'https://api.anthropic.com/v1',
  };
  const switched = t.applyApiProviderPreset(previous, 'openai');
  assert.strictEqual(switched.apiKey, '', 'switching provider clears apiKey');
  assert.strictEqual(switched.apiHeaders, '', 'switching provider clears apiHeaders');
  assert.notStrictEqual(switched.apiBaseUrl, '', 'switching provider keeps preset baseUrl (not blank)');
  assert.ok(switched.apiBaseUrl.includes('openai'), 'switched apiBaseUrl matches new openai preset');
  assert.notStrictEqual(switched, previous, 'applyApiProviderPreset returns new object');
  assert.strictEqual(previous.apiKey, 'sk-ant-secret', 'applyApiProviderPreset does not mutate input');
}

console.log('settings tests passed');
