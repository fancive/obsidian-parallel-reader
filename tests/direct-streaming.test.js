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

    const withDone = streaming.parseSseBuffer('data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n', openAiExtractor);
    assert.deepStrictEqual(withDone.deltas, ['x']);

    const withComments = streaming.parseSseBuffer(': keep-alive\nevent: message\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\n', openAiExtractor);
    assert.deepStrictEqual(withComments.deltas, ['ok']);

    const crlf = streaming.parseSseBuffer('data: {"choices":[{"delta":{"content":"crlf"}}]}\r\n\r\n', openAiExtractor);
    assert.deepStrictEqual(crlf.deltas, ['crlf']);

    const multiLine = streaming.parseSseBuffer('data: {"choices":[{"delta":\ndata: {"content":"split"}}]}\n\n', openAiExtractor);
    assert.deepStrictEqual(multiLine.deltas, ['split']);

    const malformed = streaming.parseSseBuffer('data: not-json\n\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\n', openAiExtractor);
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

    // ── streamingFetch ──
    function trackedSignal() {
      const controller = new AbortController();
      const signal = controller.signal;
      let activeListeners = 0;
      const addEventListener = signal.addEventListener.bind(signal);
      const removeEventListener = signal.removeEventListener.bind(signal);
      signal.addEventListener = (type, listener, options) => { if (type === 'abort') activeListeners++; return addEventListener(type, listener, options); };
      signal.removeEventListener = (type, listener, options) => { if (type === 'abort') activeListeners--; return removeEventListener(type, listener, options); };
      return { controller, signal, activeListeners: () => activeListeners };
    }

    function streamingBody(text) {
      const encoder = new TextEncoder();
      return new ReadableStream({ start(c) { c.enqueue(encoder.encode(text)); c.close(); } });
    }

    const originalFetch = globalThis.fetch;
    try {
      const success = trackedSignal();
      globalThis.fetch = async () => ({ ok: true, status: 200, body: streamingBody('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'), text: async () => '' });
      await streaming.streamingFetch('https://example.test', {}, {}, streaming.deltaExtractorForFormat('openai-chat'), undefined, success.signal, { streamingTimeoutMs: 1000 });
      assert.strictEqual(success.activeListeners(), 0, 'cleanup after success');

      const httpError = trackedSignal();
      globalThis.fetch = async () => ({ ok: false, status: 500, body: null, text: async () => 'bad' });
      await assert.rejects(() => streaming.streamingFetch('https://example.test', {}, {}, streaming.deltaExtractorForFormat('openai-chat'), undefined, httpError.signal, { streamingTimeoutMs: 1000 }), /HTTP 500|API returned HTTP 500/);
      assert.strictEqual(httpError.activeListeners(), 0, 'cleanup after HTTP error');

      const timeout = trackedSignal();
      globalThis.fetch = async () => new Promise(() => {});
      await assert.rejects(() => streaming.streamingFetch('https://example.test', {}, {}, streaming.deltaExtractorForFormat('openai-chat'), undefined, timeout.signal, { streamingTimeoutMs: 1 }), /Streaming timed out/);
      assert.strictEqual(timeout.activeListeners(), 0, 'cleanup after timeout');

      const preAborted = trackedSignal();
      preAborted.controller.abort();
      globalThis.fetch = async (_url, opts) => { if (opts?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError'); throw new Error('should not reach'); };
      await assert.rejects(() => streaming.streamingFetch('https://example.test', {}, {}, streaming.deltaExtractorForFormat('openai-chat'), undefined, preAborted.signal, { streamingTimeoutMs: 5000 }), /abort/i);
      assert.strictEqual(preAborted.activeListeners(), 0, 'cleanup on pre-aborted');

      const abortDuringRead = trackedSignal();
      globalThis.fetch = async (_url, opts) => {
        const fetchSignal = opts?.signal;
        const stream = new ReadableStream({
          async pull(ctrl) {
            ctrl.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'));
            abortDuringRead.controller.abort();
            await new Promise((r) => setTimeout(r, 5));
            if (fetchSignal?.aborted) { ctrl.error(new DOMException('The operation was aborted.', 'AbortError')); return; }
            ctrl.close();
          },
        });
        return { ok: true, status: 200, body: stream, text: async () => '' };
      };
      await assert.rejects(() => streaming.streamingFetch('https://example.test', {}, {}, streaming.deltaExtractorForFormat('openai-chat'), undefined, abortDuringRead.signal, { streamingTimeoutMs: 5000 }), /abort/i);
      assert.strictEqual(abortDuringRead.activeListeners(), 0, 'cleanup after mid-read abort');
    } finally {
      globalThis.fetch = originalFetch;
    }

    console.log('direct streaming tests passed');
  } finally {
    cleanup();
  }
})().catch((e) => { console.error(e); process.exit(1); });
