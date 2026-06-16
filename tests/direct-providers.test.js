const { assert, requireBundledModule, cleanup } = require('./direct-test-setup');

(async () => {
  try {
    const generation = await requireBundledModule('src/generation.ts');
    const providerParsers = await requireBundledModule('src/provider-parsers.ts');
    const providerRequest = await requireBundledModule('src/provider-request.ts');

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

    // ── provider-request: structured-output fallback keyed on HTTP status, not localized text ──
    const { ProviderApiError, shouldRetryWithoutStructuredOutput, requestJsonBodyWithStructuredFallback } =
      providerRequest;

    // 400 + body keyword ⇒ retry, regardless of the (i18n-translated) message language.
    assert.strictEqual(
      shouldRetryWithoutStructuredOutput(
        new ProviderApiError('英語以外のエラーメッセージ', 400, 'response_format is not supported'),
      ),
      true,
      'status-400 + body keyword ⇒ retry even when message is non-English/Chinese',
    );
    assert.strictEqual(
      shouldRetryWithoutStructuredOutput(
        new ProviderApiError("L'API a renvoyé une erreur", 422, 'json_schema unsupported'),
      ),
      true,
      'status-422 + body keyword ⇒ retry for a French-localized message',
    );
    // 5xx is a server error, never a structured-output problem ⇒ do not retry.
    assert.strictEqual(
      shouldRetryWithoutStructuredOutput(new ProviderApiError('server error', 500, 'response_format')),
      false,
    );
    // 400 without any schema-related keyword ⇒ do not retry.
    assert.strictEqual(
      shouldRetryWithoutStructuredOutput(new ProviderApiError('bad request', 400, 'missing required field: model')),
      false,
    );
    // Model-name errors ("unknown model" / "unrecognized model ID") must NOT trigger a
    // wasted fallback retry — bare unknown/unrecognized keywords were dropped for this.
    assert.strictEqual(
      shouldRetryWithoutStructuredOutput(new ProviderApiError('bad request', 400, 'unknown model: gpt-5')),
      false,
    );
    assert.strictEqual(
      shouldRetryWithoutStructuredOutput(new ProviderApiError('bad request', 400, 'unrecognized model ID: x')),
      false,
    );
    // Legacy path: a plain Error carrying the English template still works (back-compat).
    assert.strictEqual(
      shouldRetryWithoutStructuredOutput(new Error('OpenAI API returned HTTP 400: response_format not supported')),
      true,
    );
    assert.strictEqual(shouldRetryWithoutStructuredOutput(new Error('some unrelated error')), false);

    // End-to-end: a 400 returned alongside a NON-English locale still triggers the fallback body.
    {
      const calls = [];
      const fakeRequestUrl = async ({ body }) => {
        calls.push(JSON.parse(body));
        if (calls.length === 1) {
          return { status: 400, json: null, text: 'response_format is not supported by this model' };
        }
        return { status: 200, json: { ok: true }, text: '' };
      };
      const result = await requestJsonBodyWithStructuredFallback(
        fakeRequestUrl,
        'OpenAI-compatible Chat',
        'https://example.test',
        {},
        { model: 'x', response_format: { type: 'json_schema' } },
        { model: 'x' },
        { uiLanguage: 'fr' }, // localized error message must NOT block the fallback
      );
      assert.deepStrictEqual(result, { ok: true });
      assert.strictEqual(calls.length, 2, 'should retry exactly once without structured output');
      assert.ok(!('response_format' in calls[1]), 'fallback body omits response_format');
    }

    console.log('direct providers tests passed');
  } finally {
    cleanup();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
