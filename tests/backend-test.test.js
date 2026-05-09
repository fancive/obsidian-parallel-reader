const { assert, baseSettings, EventEmitter, openAiCardsResponse, t } = require('./test-setup');

function createFakeChild(stdoutText, stderrText = '', code = 0) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    written: '',
    ended: false,
    write(value) {
      this.written += value;
    },
    end() {
      this.ended = true;
    },
  };
  child.pid = 1234;
  child.kill = () => true;

  process.nextTick(() => {
    if (stdoutText) child.stdout.emit('data', Buffer.from(stdoutText));
    if (stderrText) child.stderr.emit('data', Buffer.from(stderrText));
    child.emit('close', code, null);
  });

  return child;
}

async function testClaudeBackendRunsVersionAndSmoke() {
  const calls = [];
  const streamJson = [
    JSON.stringify({ type: 'system', subtype: 'init', tools: ['LSP'] }),
    JSON.stringify({
      type: 'result',
      result: '{"cards":[{"title":"CLI smoke","anchor":"parallel reader smoke anchor","gist":"ok","bullets":["ok"]}]}',
    }),
    '',
  ].join('\n');
  const spawnImpl = (cmd, args) => {
    calls.push({ cmd, args });
    if (args.includes('--version')) return createFakeChild('2.1.133 (Claude Code)\n');
    return createFakeChild(streamJson);
  };

  const result = await t.testBackend(
    {
      ...baseSettings,
      backend: 'claude-code',
      cliPath: '/usr/bin/claude',
      cliTimeoutMs: 300000,
      model: 'claude-sonnet-4-6',
      promptLanguage: 'zh',
      minCards: 5,
      maxCards: 15,
      maxDocChars: 100000,
    },
    { spawnImpl },
  );

  assert.match(result, /claude @ \/usr\/bin\/claude/, 'result shows resolved Claude command');
  assert.match(result, /2\.1\.133/, 'result includes CLI version output');
  assert.match(result, /smoke: 1 card/, 'result includes parsed smoke-card count');
  assert.deepStrictEqual(calls[0].args, ['--version'], 'first Claude call checks version');

  const smokeArgs = calls[1].args;
  assert.strictEqual(smokeArgs[0], '-p', 'Claude smoke uses print mode');
  assert.strictEqual(
    smokeArgs[smokeArgs.indexOf('--output-format') + 1],
    'stream-json',
    'Claude smoke uses stream-json for incremental output',
  );
  assert.strictEqual(smokeArgs[smokeArgs.indexOf('--tools') + 1], '', 'Claude smoke disables tools');
  assert.ok(smokeArgs.includes('--strict-mcp-config'), 'Claude smoke ignores user/project MCP servers');
  assert.strictEqual(
    smokeArgs[smokeArgs.indexOf('--mcp-config') + 1],
    '{"mcpServers":{}}',
    'Claude smoke passes an empty MCP config',
  );
}

async function testCodexBackendRunsVersionAndSmoke() {
  const calls = [];
  const resultJson =
    '{"cards":[{"title":"CLI smoke","anchor":"parallel reader smoke anchor","gist":"ok","bullets":["ok"]}]}';
  const spawnImpl = (cmd, args) => {
    calls.push({ cmd, args });
    if (args.includes('--version')) return createFakeChild('codex-cli 1.2.3\n');
    return createFakeChild(resultJson);
  };

  const result = await t.testBackend(
    {
      ...baseSettings,
      backend: 'codex',
      cliPath: '/usr/bin/codex',
      cliTimeoutMs: 300000,
      promptLanguage: 'zh',
      minCards: 5,
      maxCards: 15,
      maxDocChars: 100000,
    },
    { spawnImpl },
  );

  assert.match(result, /codex @ \/usr\/bin\/codex/, 'result shows resolved Codex command');
  assert.match(result, /codex-cli 1\.2\.3/, 'result includes CLI version output');
  assert.match(result, /smoke: 1 card/, 'result includes parsed smoke-card count');
  assert.deepStrictEqual(calls[0].args, ['--version'], 'first Codex call checks version');
  assert.strictEqual(calls[1].args[0], 'exec', 'Codex smoke runs through codex exec');
  assert.strictEqual(calls[1].args[calls[1].args.indexOf('--sandbox') + 1], 'read-only', 'Codex smoke is read-only');
}

async function testApiBackendUsesInjectedRequestUrl() {
  let called = false;
  const result = await t.testBackend(
    {
      ...baseSettings,
      apiHeaders: '',
      maxDocChars: 100000,
      promptLanguage: 'zh',
      minCards: 5,
      maxCards: 15,
    },
    {
      requestUrlImpl: async () => {
        called = true;
        return openAiCardsResponse([]);
      },
    },
  );

  assert.strictEqual(called, true, 'API backend test should use injected requestUrl');
  assert.strictEqual(result, 'OpenAI / OpenAI Chat Completions', 'API backend test reports provider and format');
}

(async () => {
  await testClaudeBackendRunsVersionAndSmoke();
  await testCodexBackendRunsVersionAndSmoke();
  await testApiBackendUsesInjectedRequestUrl();
  console.log('backend-test tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
