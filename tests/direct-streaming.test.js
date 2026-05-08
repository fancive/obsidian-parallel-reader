const { assert, requireBundledModule, cleanup } = require('./direct-test-setup');

(async () => {
  try {
    const streaming = await requireBundledModule('src/streaming.ts');

    const openAiExtractor = streaming.deltaExtractorForFormat('openai-chat');
    const anthropicExtractor = streaming.deltaExtractorForFormat('anthropic-messages');

    assert.ok(openAiExtractor);
    assert.ok(anthropicExtractor);
    assert.strictEqual(streaming.deltaExtractorForFormat('unknown-format'), null);
    assert.strictEqual(streaming.deltaExtractorForFormat('google-generative-ai'), null);

    assert.strictEqual(openAiExtractor({ choices: [{ delta: { content: 'hello' } }] }), 'hello');
    assert.strictEqual(openAiExtractor({ choices: [{ delta: {} }] }), '');
    assert.strictEqual(openAiExtractor({}), '');

    assert.strictEqual(anthropicExtractor({ type: 'content_block_delta', delta: { text: 'world' } }), 'world');
    assert.strictEqual(anthropicExtractor({ type: 'content_block_start' }), '');
    assert.strictEqual(anthropicExtractor({}), '');

    // ── parseSseBuffer ──
    const single = streaming.parseSseBuffer('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', openAiExtractor);
    assert.deepStrictEqual(single.deltas, ['hi']);
    assert.strictEqual(single.rest, '');

    const multi = streaming.parseSseBuffer(
      'data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: {"choices":[{"delta":{"content":"b"}}]}\n\n',
      openAiExtractor,
    );
    assert.deepStrictEqual(multi.deltas, ['a', 'b']);

    const incomplete = streaming.parseSseBuffer('data: {"choices":[{"delta":{"content":"partial"}}]}', openAiExtractor);
    assert.deepStrictEqual(incomplete.deltas, []);
    assert.ok(incomplete.rest.length > 0);

    const withDone = streaming.parseSseBuffer(
      'data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n',
      openAiExtractor,
    );
    assert.deepStrictEqual(withDone.deltas, ['x']);

    const withComments = streaming.parseSseBuffer(
      ': keep-alive\nevent: message\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      openAiExtractor,
    );
    assert.deepStrictEqual(withComments.deltas, ['ok']);

    const crlf = streaming.parseSseBuffer('data: {"choices":[{"delta":{"content":"crlf"}}]}\r\n\r\n', openAiExtractor);
    assert.deepStrictEqual(crlf.deltas, ['crlf']);

    const multiLine = streaming.parseSseBuffer(
      'data: {"choices":[{"delta":\ndata: {"content":"split"}}]}\n\n',
      openAiExtractor,
    );
    assert.deepStrictEqual(multiLine.deltas, ['split']);

    const malformed = streaming.parseSseBuffer(
      'data: not-json\n\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      openAiExtractor,
    );
    assert.deepStrictEqual(malformed.deltas, ['ok']);

    const anthEvent = streaming.parseSseBuffer(
      'data: {"type":"content_block_delta","delta":{"text":"ant"}}\n\ndata: {"type":"message_stop"}\n\n',
      anthropicExtractor,
    );
    assert.deepStrictEqual(anthEvent.deltas, ['ant']);

    const noSpace = streaming.parseSseBuffer('data:{"choices":[{"delta":{"content":"ns"}}]}\n\n', openAiExtractor);
    assert.deepStrictEqual(noSpace.deltas, ['ns']);

    const empty = streaming.parseSseBuffer('', openAiExtractor);
    assert.deepStrictEqual(empty.deltas, []);

    // ── streamingRequestUrl ──
    function trackedSignal() {
      const controller = new AbortController();
      const signal = controller.signal;
      let activeListeners = 0;
      const addEventListener = signal.addEventListener.bind(signal);
      const removeEventListener = signal.removeEventListener.bind(signal);
      signal.addEventListener = (type, listener, options) => {
        if (type === 'abort') activeListeners++;
        return addEventListener(type, listener, options);
      };
      signal.removeEventListener = (type, listener, options) => {
        if (type === 'abort') activeListeners--;
        return removeEventListener(type, listener, options);
      };
      return { controller, signal, activeListeners: () => activeListeners };
    }

    {
      const success = trackedSignal();
      const progress = [];
      const text = await streaming.streamingRequestUrl(
        async (params) => {
          assert.strictEqual(params.method, 'POST');
          assert.strictEqual(params.url, 'https://example.test');
          assert.strictEqual(params.body, '{"stream":true}');
          return {
            status: 200,
            json: null,
            text: 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
          };
        },
        'https://example.test',
        {},
        { stream: true },
        streaming.deltaExtractorForFormat('openai-chat'),
        (p) => progress.push(p),
        success.signal,
        { streamingTimeoutMs: 1000 },
      );
      assert.strictEqual(text, 'ok');
      assert.deepStrictEqual(progress, [
        { accumulated: 'ok', done: false },
        { accumulated: 'ok', done: true },
      ]);
      assert.strictEqual(success.activeListeners(), 0, 'cleanup after success');
    }

    {
      const httpError = trackedSignal();
      await assert.rejects(
        () =>
          streaming.streamingRequestUrl(
            async () => ({ status: 500, json: null, text: 'bad' }),
            'https://example.test',
            {},
            {},
            streaming.deltaExtractorForFormat('openai-chat'),
            undefined,
            httpError.signal,
            { streamingTimeoutMs: 1000 },
          ),
        /HTTP 500|API returned HTTP 500/,
      );
      assert.strictEqual(httpError.activeListeners(), 0, 'cleanup after HTTP error');
    }

    {
      const timeout = trackedSignal();
      await assert.rejects(
        () =>
          streaming.streamingRequestUrl(
            async () => new Promise(() => {}),
            'https://example.test',
            {},
            {},
            streaming.deltaExtractorForFormat('openai-chat'),
            undefined,
            timeout.signal,
            { streamingTimeoutMs: 1 },
          ),
        /Streaming timed out/,
      );
      assert.strictEqual(timeout.activeListeners(), 0, 'cleanup after timeout');
    }

    {
      const preAborted = trackedSignal();
      preAborted.controller.abort();
      let called = false;
      await assert.rejects(
        () =>
          streaming.streamingRequestUrl(
            async () => {
              called = true;
              return { status: 200, json: null, text: '' };
            },
            'https://example.test',
            {},
            {},
            streaming.deltaExtractorForFormat('openai-chat'),
            undefined,
            preAborted.signal,
            { streamingTimeoutMs: 5000 },
          ),
        /abort/i,
      );
      assert.strictEqual(called, false, 'pre-aborted request is not started');
      assert.strictEqual(preAborted.activeListeners(), 0, 'cleanup on pre-aborted');
    }

    {
      const abortDuringRequest = trackedSignal();
      await assert.rejects(
        () =>
          streaming.streamingRequestUrl(
            async () =>
              new Promise((resolve) => {
                setTimeout(() => abortDuringRequest.controller.abort(), 1);
                setTimeout(() => resolve({ status: 200, json: null, text: '' }), 20);
              }),
            'https://example.test',
            {},
            {},
            streaming.deltaExtractorForFormat('openai-chat'),
            undefined,
            abortDuringRequest.signal,
            { streamingTimeoutMs: 5000 },
          ),
        /abort/i,
      );
      assert.strictEqual(abortDuringRequest.activeListeners(), 0, 'cleanup after mid-request abort');
    }

    {
      const requestFailure = trackedSignal();
      await assert.rejects(
        () =>
          streaming.streamingRequestUrl(
            async () => {
              throw new Error('network down');
            },
            'https://example.test',
            {},
            {},
            streaming.deltaExtractorForFormat('openai-chat'),
            undefined,
            requestFailure.signal,
            { streamingTimeoutMs: 1000 },
          ),
        /network down/,
      );
      assert.strictEqual(requestFailure.activeListeners(), 0, 'cleanup after transport failure');
    }

    console.log('direct streaming tests passed');
  } finally {
    cleanup();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
