const { assert, requireBundledModule, cleanup } = require('./direct-test-setup');

(async () => {
  try {
    const generation = await requireBundledModule('src/generation.ts');
    const providerParsers = await requireBundledModule('src/provider-parsers.ts');

    // ── generation.ts ──
    assert.strictEqual(
      generation.cancellationNoticeKey({ backend: 'api' }, { phase: 'generating' }),
      'cancelRequestedApiInFlight',
    );
    assert.strictEqual(
      generation.cancellationNoticeKey({ backend: 'codex' }, { phase: 'generating' }),
      'cancelRequested',
    );

    // ── provider-parsers.ts ──
    const cardsJson = JSON.stringify({ cards: [{ title: 'T', anchor: 'A', gist: 'G', bullets: ['B'] }] });
    assert.strictEqual(
      providerParsers.textFromOpenAiChatResponse({ choices: [{ message: { content: [{ text: cardsJson }] } }] }),
      cardsJson,
    );
    assert.strictEqual(
      providerParsers.textFromAnthropicMessagesResponse({ content: [{ type: 'text', text: cardsJson }] }),
      cardsJson,
    );
    assert.strictEqual(
      providerParsers.textFromOpenAiResponsesResponse({
        output: [{ content: [{ type: 'output_text', text: cardsJson }] }],
      }),
      cardsJson,
    );
    assert.strictEqual(
      providerParsers.textFromGoogleGenerativeAiResponse({
        candidates: [{ content: { parts: [{ text: cardsJson }] } }],
      }),
      cardsJson,
    );
    assert.deepStrictEqual(
      providerParsers.cardsFromAnthropicToolUse({
        content: [{ type: 'tool_use', name: 'record_parallel_reader_cards', input: JSON.parse(cardsJson) }],
      }),
      [{ title: 'T', anchor: 'A', gist: 'G', bullets: ['B'] }],
    );

    // ── Provider parser edge cases ──
    assert.strictEqual(providerParsers.textFromProviderContent('hello'), 'hello');
    assert.strictEqual(providerParsers.textFromProviderContent({ output_text: 'ot' }), 'ot');
    assert.strictEqual(providerParsers.textFromProviderContent(['a', { text: 'b' }, { output_text: 'c' }, 42]), 'abc');
    assert.strictEqual(providerParsers.textFromProviderContent(null), '');
    assert.strictEqual(providerParsers.textFromProviderContent(undefined), '');
    assert.strictEqual(providerParsers.textFromProviderContent({ foo: 'bar' }), '');

    assert.strictEqual(providerParsers.textFromOpenAiChatResponse({}), '');
    assert.strictEqual(providerParsers.textFromOpenAiChatResponse({ choices: [] }), '');
    assert.strictEqual(providerParsers.textFromOpenAiChatResponse({ choices: [{ text: 'legacy' }] }), 'legacy');

    assert.strictEqual(providerParsers.textFromAnthropicMessagesResponse({}), '');
    assert.strictEqual(providerParsers.textFromAnthropicMessagesResponse({ content: [] }), '');
    assert.strictEqual(
      providerParsers.textFromAnthropicMessagesResponse({
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
      }),
      'ab',
    );

    assert.strictEqual(providerParsers.textFromGoogleGenerativeAiResponse({}), '');
    assert.strictEqual(providerParsers.textFromGoogleGenerativeAiResponse({ candidates: [] }), '');
    assert.strictEqual(providerParsers.textFromGoogleGenerativeAiResponse({ candidates: [{ content: {} }] }), '');

    assert.strictEqual(providerParsers.textFromOpenAiResponsesResponse({ output_text: 'direct' }), 'direct');
    assert.strictEqual(
      providerParsers.textFromOpenAiResponsesResponse({
        output: [{ content: [{ type: 'output_text', content: 'nested' }] }],
      }),
      'nested',
    );
    assert.strictEqual(providerParsers.textFromOpenAiResponsesResponse({}), '');

    assert.strictEqual(providerParsers.cardsFromAnthropicToolUse({ content: [{ type: 'text', text: 'hello' }] }), null);
    assert.strictEqual(
      providerParsers.cardsFromAnthropicToolUse({ content: [{ type: 'tool_use', name: 'other_tool', input: {} }] }),
      null,
    );
    assert.strictEqual(providerParsers.cardsFromAnthropicToolUse({}), null);

    console.log('direct providers tests passed');
  } finally {
    cleanup();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
