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
  'different model = different fp',
);
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

console.log('settings tests passed');
