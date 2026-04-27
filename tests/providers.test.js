const { assert, t, baseSettings, openAiCardsResponse, setRequestUrlMock } = require('./test-setup');

// ── prompt.ts ──

const enPrompt = t.buildPrompts('Hello world', {
  ...baseSettings,
  promptLanguage: 'en',
  minCards: 3,
  maxCards: 7,
});
assert.ok(enPrompt.system.includes('3-7'), 'card range in system prompt');
assert.ok(enPrompt.system.includes('English'), 'language instruction in english prompt');
assert.ok(enPrompt.user.includes('Source document:'), 'english user prompt prefix');
assert.ok(enPrompt.user.includes('Hello world'), 'content in user prompt');

const zhPrompt = t.buildPrompts('你好世界', {
  ...baseSettings,
  promptLanguage: 'zh',
  minCards: 2,
  maxCards: 5,
});
assert.ok(zhPrompt.system.includes('2-5'), 'zh card range');
assert.ok(zhPrompt.system.includes('中文'), 'chinese language instruction');
assert.ok(zhPrompt.user.includes('你好世界'), 'zh content');

const customPrompt = t.buildPrompts('doc', {
  ...baseSettings,
  promptLanguage: 'en',
  minCards: 1,
  maxCards: 3,
  customSystemPrompt: 'Generate {minCards} to {maxCards} cards. {languageInstruction}',
});
assert.ok(customPrompt.system.includes('Generate 1 to 3 cards'), 'custom prompt variable substitution');
assert.ok(customPrompt.system.includes('Non-overridable output contract'), 'contract appended to custom prompt');

const longDoc = 'x'.repeat(25000);
const truncated = t.buildPrompts(longDoc, {
  ...baseSettings,
  promptLanguage: 'en',
  minCards: 1,
  maxCards: 3,
  maxDocChars: 20000,
});
assert.ok(truncated.user.includes('[Document truncated]'), 'truncation marker');
assert.ok(truncated.user.length < 25000, 'content actually truncated');

// ── provider body builders ──

const chatBody = t.buildOpenAiChatBody('sys', 'usr', { ...baseSettings, apiMaxTokens: 200 });
assert.strictEqual(chatBody.model, 'gpt-5.1', 'model stripped');
assert.strictEqual(chatBody.messages.length, 2, 'system + user messages');
assert.ok(chatBody.response_format, 'has structured output');

const chatUnstructured = t.buildOpenAiChatBody('sys', 'usr', baseSettings, { structured: false });
assert.strictEqual(chatUnstructured.response_format, undefined, 'no structured output when disabled');

const anthBody = t.buildAnthropicMessagesBody('sys', 'usr', {
  ...baseSettings,
  apiProvider: 'anthropic',
  apiFormat: 'anthropic-messages',
  model: 'claude-sonnet-4-6',
});
assert.ok(anthBody.tools, 'has tools for structured output');
assert.strictEqual(anthBody.tools[0].name, 'record_parallel_reader_cards');
assert.strictEqual(anthBody.system, 'sys', 'system prompt set');

const respBody = t.buildOpenAiResponsesBody('sys', 'usr', baseSettings);
assert.strictEqual(respBody.instructions, 'sys', 'instructions set');
assert.strictEqual(respBody.input, 'usr', 'input set');
assert.ok(respBody.text, 'has text format');

const gemBody = t.buildGeminiBody('sys', 'usr', {
  ...baseSettings,
  apiProvider: 'google',
  apiFormat: 'google-generative-ai',
  model: 'gemini-3-pro-preview',
});
assert.strictEqual(gemBody.systemInstruction.parts[0].text, 'sys');
assert.strictEqual(gemBody.contents[0].parts[0].text, 'usr');
assert.strictEqual(gemBody.generationConfig.responseMimeType, 'application/json');

assert.strictEqual(
  t.tokenLimitFieldForOpenAiChat({ ...baseSettings, apiProvider: 'openai' }),
  'max_completion_tokens',
  'OpenAI uses max_completion_tokens',
);
assert.strictEqual(
  t.tokenLimitFieldForOpenAiChat({ ...baseSettings, apiProvider: 'openrouter' }),
  'max_tokens',
  'OpenRouter uses max_tokens',
);

// ── parseApiHeaders ──

assert.deepStrictEqual(
  t.parseApiHeaders('{"X-Custom": "value", "Authorization": "Bearer tok"}'),
  { 'X-Custom': 'value', Authorization: 'Bearer tok' },
  'parseApiHeaders: JSON object input',
);
assert.deepStrictEqual(t.parseApiHeaders(''), {}, 'parseApiHeaders: empty string returns empty object');
assert.deepStrictEqual(t.parseApiHeaders('  '), {}, 'parseApiHeaders: whitespace-only returns empty object');
assert.deepStrictEqual(
  t.parseApiHeaders('X-Custom: value\nAuthorization: Bearer tok'),
  { 'X-Custom': 'value', Authorization: 'Bearer tok' },
  'parseApiHeaders: line-based input',
);
assert.deepStrictEqual(
  t.parseApiHeaders('# comment\nX-Key: val\n\n# another\nY-Key: val2'),
  { 'X-Key': 'val', 'Y-Key': 'val2' },
  'parseApiHeaders: comments and blank lines skipped',
);
assert.throws(
  () => t.parseApiHeaders('{ invalid json }', baseSettings),
  /parse failed|JSON/i,
  'parseApiHeaders: malformed JSON throws',
);
assert.throws(
  () => t.parseApiHeaders('[1, 2, 3]', baseSettings),
  /Header.*value|format/i,
  'parseApiHeaders: JSON array input throws line format error',
);
assert.throws(
  () => t.parseApiHeaders('InvalidHeader', baseSettings),
  /Header.*value|format/i,
  'parseApiHeaders: missing colon throws',
);
assert.deepStrictEqual(
  t.parseApiHeaders('{"valid": "yes", "number": 42, "null": null}'),
  { valid: 'yes' },
  'parseApiHeaders: non-string values filtered from JSON',
);
assert.deepStrictEqual(
  t.parseApiHeaders('Authorization: Bearer abc:def:ghi'),
  { Authorization: 'Bearer abc:def:ghi' },
  'parseApiHeaders: value with colons preserved',
);

// ── summarizeDocument ──

async function testSummarizeDocumentAnchorSorting() {
  const prev = require('./test-setup').getRequestUrlMock();
  setRequestUrlMock(async () =>
    openAiCardsResponse([
      { title: 'Second', anchor: 'second anchor', gist: 'G2', bullets: ['B2'] },
      { title: 'First', anchor: 'first anchor', gist: 'G1', bullets: ['B1'] },
    ]),
  );

  let sections;
  try {
    sections = await t.summarizeDocument(
      'intro\nfirst anchor\nmiddle\nsecond anchor\nend',
      { ...baseSettings, streaming: false, promptLanguage: 'en', minCards: 1, maxCards: 3, maxDocChars: 10000 },
      { phase: 'queued', onCancel: () => {}, throwIfCancelled: () => {}, setPhase: () => {} },
    );
  } finally {
    setRequestUrlMock(prev);
  }

  assert.deepStrictEqual(
    sections.map((s) => s.title),
    ['First', 'Second'],
    'sorts by anchor line',
  );
  assert.deepStrictEqual(
    sections.map((s) => s.startLine),
    [1, 3],
    'resolves anchor lines',
  );
}

async function testStructuredOutputFallback() {
  const prev = require('./test-setup').getRequestUrlMock();
  let callCount = 0;
  setRequestUrlMock(async () => {
    callCount++;
    if (callCount === 1) {
      return {
        status: 400,
        json: { error: 'response_format is not supported' },
        text: JSON.stringify({ error: 'response_format is not supported' }),
      };
    }
    return openAiCardsResponse([{ title: 'Fallback', anchor: 'fallback anchor', gist: 'G', bullets: ['B'] }]);
  });

  try {
    const sections = await t.summarizeDocument(
      'intro\nfallback anchor\nend',
      { ...baseSettings, streaming: false, promptLanguage: 'en', minCards: 1, maxCards: 3, maxDocChars: 10000 },
      { phase: 'queued', onCancel: () => {}, throwIfCancelled: () => {}, setPhase: () => {} },
    );
    assert.strictEqual(callCount, 2, 'structured output fallback made two requests');
    assert.strictEqual(sections[0].title, 'Fallback', 'fallback response parsed correctly');
  } finally {
    setRequestUrlMock(prev);
  }
}

async function testStructuredOutputNonRetryableError() {
  const prev = require('./test-setup').getRequestUrlMock();
  setRequestUrlMock(async () => ({
    status: 500,
    json: { error: 'Internal server error' },
    text: JSON.stringify({ error: 'Internal server error' }),
  }));

  try {
    await assert.rejects(
      () =>
        t.summarizeDocument(
          'test content',
          { ...baseSettings, streaming: false, promptLanguage: 'en', minCards: 1, maxCards: 3, maxDocChars: 10000 },
          { phase: 'queued', onCancel: () => {}, throwIfCancelled: () => {}, setPhase: () => {} },
        ),
      /500/,
      'non-retryable error (500) is not caught by structured fallback',
    );
  } finally {
    setRequestUrlMock(prev);
  }
}

async function testProviderMissingApiKey() {
  await assert.rejects(
    () =>
      t.summarizeViaApi(
        async () => {
          throw new Error('request should not be sent');
        },
        'system JSON',
        'user',
        { ...baseSettings, apiKey: '', apiKeyEnvVar: '', uiLanguage: 'en' },
      ),
    /API key is not set/,
  );
}

async function testProviderHeaderJsonError() {
  await assert.rejects(
    () =>
      t.summarizeViaApi(
        async () => {
          throw new Error('request should not be sent');
        },
        'system JSON',
        'user',
        { ...baseSettings, apiHeaders: '{"x":', uiLanguage: 'en' },
      ),
    /Custom headers JSON parse failed/,
  );
}

async function testProviderResponseNonJson() {
  await assert.rejects(
    () =>
      t.summarizeViaApi(async () => ({ status: 200, text: '<html>not json</html>' }), 'system JSON', 'user', {
        ...baseSettings,
        uiLanguage: 'en',
      }),
    /OpenAI-compatible Chat returned non-JSON/,
  );
}

async function testProviderRequestFailure() {
  await assert.rejects(
    () =>
      t.summarizeViaApi(
        async () => {
          throw new Error('network down');
        },
        'system JSON',
        'user',
        { ...baseSettings, uiLanguage: 'en' },
      ),
    /OpenAI-compatible Chat request failed: network down/,
  );
}

async function testProviderApiStatusError() {
  await assert.rejects(
    () =>
      t.summarizeViaApi(async () => ({ status: 500, text: 'upstream exploded' }), 'system JSON', 'user', {
        ...baseSettings,
        uiLanguage: 'en',
      }),
    /OpenAI-compatible Chat API returned HTTP 500: upstream exploded/,
  );
}

async function testAnthropicToolUseParsing() {
  const cards = await t.summarizeViaApi(
    async (req) => {
      const body = JSON.parse(req.body);
      assert.strictEqual(body.tools[0].name, 'record_parallel_reader_cards');
      return {
        status: 200,
        json: {
          content: [
            {
              type: 'tool_use',
              name: 'record_parallel_reader_cards',
              input: { cards: [{ title: 'A', anchor: 'quote', gist: 'gist', bullets: ['one'] }] },
            },
          ],
        },
      };
    },
    'system JSON',
    'user',
    {
      ...baseSettings,
      apiProvider: 'anthropic',
      apiFormat: 'anthropic-messages',
      apiBaseUrl: 'https://api.anthropic.com/v1',
      apiAuthType: 'x-api-key',
      model: 'anthropic/claude-sonnet-4-6',
    },
  );
  assert.deepStrictEqual(cards, [{ title: 'A', anchor: 'quote', gist: 'gist', bullets: ['one'] }]);
}

// cancellationNoticeKey
assert.strictEqual(
  t.cancellationNoticeKey({ backend: 'api' }, { phase: 'generating' }),
  'cancelRequestedApiInFlight',
  'API cancellation should explain that the in-flight network request cannot be aborted',
);
assert.strictEqual(
  t.cancellationNoticeKey({ backend: 'claude-code' }, { phase: 'generating' }),
  'cancelRequested',
  'CLI cancellation can use the generic cancellation notice',
);
assert.strictEqual(
  t.cancellationNoticeKey({ backend: 'api' }, { phase: 'reading' }),
  'cancelRequested',
  'API cancellation outside the request phase can use the generic notice',
);

(async () => {
  await testSummarizeDocumentAnchorSorting();
  await testStructuredOutputFallback();
  await testStructuredOutputNonRetryableError();
  await testProviderMissingApiKey();
  await testProviderHeaderJsonError();
  await testProviderResponseNonJson();
  await testProviderRequestFailure();
  await testProviderApiStatusError();
  await testAnthropicToolUseParsing();
  console.log('providers tests passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
