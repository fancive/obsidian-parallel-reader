const { assert, t, baseSettings } = require('./test-setup');

// ── supportsStreaming ──

assert.strictEqual(
  t.supportsStreaming({ ...baseSettings, streaming: true, apiFormat: 'openai-chat' }),
  true,
  'OpenAI Chat supports streaming',
);
assert.strictEqual(
  t.supportsStreaming({ ...baseSettings, streaming: true, apiFormat: 'anthropic-messages', apiProvider: 'anthropic' }),
  true,
  'Anthropic Messages supports streaming',
);
assert.strictEqual(
  t.supportsStreaming({ ...baseSettings, streaming: true, apiFormat: 'google-generative-ai', apiProvider: 'google' }),
  false,
  'Gemini does not support streaming',
);
assert.strictEqual(
  t.supportsStreaming({ ...baseSettings, streaming: false, apiFormat: 'openai-chat' }),
  false,
  'streaming disabled returns false',
);

// ── deltaExtractorForFormat ──

const openaiExtract = t.deltaExtractorForFormat('openai-chat');
assert.ok(openaiExtract, 'openai-chat extractor exists');
assert.strictEqual(openaiExtract({ choices: [{ delta: { content: 'hello' } }] }), 'hello', 'extracts OpenAI delta');
assert.strictEqual(openaiExtract({ choices: [{ delta: {} }] }), '', 'empty delta');
assert.strictEqual(openaiExtract({}), '', 'missing choices');

const anthropicExtract = t.deltaExtractorForFormat('anthropic-messages');
assert.ok(anthropicExtract, 'anthropic extractor exists');
assert.strictEqual(
  anthropicExtract({ type: 'content_block_delta', delta: { text: 'world' } }),
  'world',
  'extracts Anthropic delta',
);
assert.strictEqual(anthropicExtract({ type: 'message_start' }), '', 'non-delta event returns empty');

assert.strictEqual(t.deltaExtractorForFormat('google-generative-ai'), null, 'no extractor for gemini');

// ── parseSseBuffer ──

const sseResult = t.parseSseBuffer(
  'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"choices":[{"delta":{"content":" there"}}]}\n\ndata: [DONE]\n\npartial',
  openaiExtract,
);
assert.deepStrictEqual(sseResult.deltas, ['hi', ' there'], 'SSE parser extracts deltas');
assert.strictEqual(sseResult.rest, 'partial', 'SSE parser keeps partial line');

const sseEmpty = t.parseSseBuffer('', openaiExtract);
assert.deepStrictEqual(sseEmpty.deltas, []);
assert.strictEqual(sseEmpty.rest, '');

const anthSse = t.parseSseBuffer(
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"token"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
  anthropicExtract,
);
assert.deepStrictEqual(anthSse.deltas, ['token'], 'Anthropic SSE extracts text delta');

const ssePartial = t.parseSseBuffer('data: {"choices":[{"delta":{"content":"ok"}}]}', openaiExtract);
assert.deepStrictEqual(ssePartial.deltas, [], 'incomplete line yields no deltas');
assert.ok(ssePartial.rest.includes('"ok"'), 'partial line kept in rest');

const sseMulti = t.parseSseBuffer(
  'data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: {"choices":[{"delta":{"content":"b"}}]}\n\ndata: {"choices":[{"delta":{"content":"c"}}]}\n\n',
  openaiExtract,
);
assert.deepStrictEqual(sseMulti.deltas, ['a', 'b', 'c'], 'three events in one chunk');
assert.strictEqual(sseMulti.rest, '', 'nothing left in rest when chunk ends with newline');

const sseMultilineData = t.parseSseBuffer(
  'data: {"choices":[\ndata: {"delta":{"content":"joined"}}\ndata: ]}\n\n',
  openaiExtract,
);
assert.deepStrictEqual(sseMultilineData.deltas, ['joined'], 'consecutive data lines are merged into one event');

const ssePartialEvent = t.parseSseBuffer('data: {"choices":[{"delta":{"content":"wait"}}]}\n', openaiExtract);
assert.deepStrictEqual(ssePartialEvent.deltas, [], 'event without blank-line terminator is retained');
assert.strictEqual(ssePartialEvent.rest.includes('"wait"'), true, 'partial event remains in rest');

const sseMixed = t.parseSseBuffer(
  ': comment\nevent: ping\ndata: {"choices":[{"delta":{"content":"x"}}]}\n\n',
  openaiExtract,
);
assert.deepStrictEqual(sseMixed.deltas, ['x'], 'comment and event lines ignored');

const sseBad = t.parseSseBuffer('data: not_json\n\ndata: {"choices":[{"delta":{"content":"y"}}]}\n\n', openaiExtract);
assert.deepStrictEqual(sseBad.deltas, ['y'], 'bad JSON line skipped, good line extracted');

console.log('streaming tests passed');
