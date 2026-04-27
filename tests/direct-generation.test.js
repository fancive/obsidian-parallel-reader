const { assert, requireBundledModule, cleanup } = require('./direct-test-setup');

(async () => {
  try {
    const generation = await requireBundledModule('src/generation.ts');

    // ── cancellationNoticeKey: API backend during generation ──
    assert.strictEqual(
      generation.cancellationNoticeKey({ backend: 'api' }, { phase: 'generating' }),
      'cancelRequestedApiInFlight',
      'API backend + generating = API in-flight notice',
    );
    assert.strictEqual(
      generation.cancellationNoticeKey({ backend: 'anthropic-api' }, { phase: 'generating' }),
      'cancelRequestedApiInFlight',
      'anthropic-api backend + generating = API in-flight notice',
    );

    // ── cancellationNoticeKey: CLI backends ──
    assert.strictEqual(
      generation.cancellationNoticeKey({ backend: 'claude-code' }, { phase: 'generating' }),
      'cancelRequested',
      'CLI backend uses simple cancel notice',
    );
    assert.strictEqual(
      generation.cancellationNoticeKey({ backend: 'codex' }, { phase: 'generating' }),
      'cancelRequested',
      'codex backend uses simple cancel notice',
    );

    // ── cancellationNoticeKey: non-generating phases ──
    assert.strictEqual(
      generation.cancellationNoticeKey({ backend: 'api' }, { phase: 'queued' }),
      'cancelRequested',
      'queued phase = simple cancel even for API',
    );
    assert.strictEqual(
      generation.cancellationNoticeKey({ backend: 'api' }, { phase: 'cache-check' }),
      'cancelRequested',
      'cache-check phase = simple cancel',
    );
    assert.strictEqual(
      generation.cancellationNoticeKey({ backend: 'api' }, { phase: 'reading' }),
      'cancelRequested',
      'reading phase = simple cancel',
    );
    assert.strictEqual(
      generation.cancellationNoticeKey({ backend: 'api' }, { phase: 'saving' }),
      'cancelRequested',
      'saving phase = simple cancel',
    );

    // ── cancellationNoticeKey: null/edge cases ──
    assert.strictEqual(
      generation.cancellationNoticeKey(null, { phase: 'generating' }),
      'cancelRequested',
      'null settings = simple cancel',
    );
    assert.strictEqual(
      generation.cancellationNoticeKey({ backend: 'api' }, null),
      'cancelRequested',
      'null job = simple cancel',
    );
    assert.strictEqual(generation.cancellationNoticeKey(null, null), 'cancelRequested', 'both null = simple cancel');

    console.log('direct generation tests passed');
  } finally {
    cleanup();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
