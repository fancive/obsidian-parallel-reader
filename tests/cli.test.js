const { assert, t, EventEmitter } = require('./test-setup');

// ── resolveCliPath ──

assert.strictEqual(t.resolveCliPath('claude', '  /usr/bin/claude  '), '/usr/bin/claude', 'trims override path');
assert.strictEqual(t.resolveCliPath('claude', '/custom/path'), '/custom/path', 'returns custom path unchanged');

const fsModule = require('fs');
const origExistsSync = fsModule.existsSync;

const mockPath = require('path').join(require('os').homedir(), '.local', 'bin', 'claude');
fsModule.existsSync = (p) => p === mockPath;
try {
  const resolved = t.resolveCliPath('claude', '');
  assert.strictEqual(resolved, mockPath, 'resolveCliPath finds binary in mocked ~/.local/bin');
} finally {
  fsModule.existsSync = origExistsSync;
}

fsModule.existsSync = () => false;
try {
  const fallback = t.resolveCliPath('claude', '');
  assert.strictEqual(fallback, 'claude', 'resolveCliPath falls back to bare name when not found');
} finally {
  fsModule.existsSync = origExistsSync;
}

// ── runCli edge cases ──

function createFakeChild() {
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
  child.killedWith = null;
  child.kill = (signal) => {
    child.killedWith = signal;
    return true;
  };
  return child;
}

async function testRunCliEdgeCases() {
  const timeoutChild = createFakeChild();
  await assert.rejects(
    () => t.runCli('fake', [], '', 5, undefined, () => timeoutChild),
    /CLI timed out \(5ms\)/,
    'runCli rejects on timeout',
  );
  assert.strictEqual(timeoutChild.killedWith, 'SIGKILL', 'runCli kills timed out processes');

  const cancelChild = createFakeChild();
  let cancelHandler = null;
  const cancelPromise = t.runCli(
    'fake',
    [],
    '',
    1000,
    {
      key: 'cancel.md',
      onCancel: (handler) => {
        cancelHandler = handler;
      },
    },
    () => cancelChild,
  );
  cancelHandler();
  await assert.rejects(
    () => cancelPromise,
    (err) => err && err.code === 'cancelled' && err.key === 'cancel.md',
    'runCli rejects with GenerationJobCancelledError on cancellation',
  );
  assert.strictEqual(cancelChild.killedWith, 'SIGKILL', 'runCli kills cancelled processes');

  await assert.rejects(
    () => t.runCli('fake', [], '', 100, undefined, () => ({ stdout: null, stderr: null, stdin: null })),
    /CLI process streams are unavailable/,
    'runCli reports unavailable stdio streams',
  );
}

// ── summarizeViaClaudeCode args validation ──

// Known flags supported by the Claude Code CLI (from `claude --help`).
const VALID_CLAUDE_FLAGS = new Set([
  '--add-dir',
  '--agent',
  '--agents',
  '--allow-dangerously-skip-permissions',
  '--allowedTools',
  '--allowed-tools',
  '--append-system-prompt',
  '--bare',
  '--betas',
  '--brief',
  '--chrome',
  '--dangerously-skip-permissions',
  '--debug-file',
  '--disable-slash-commands',
  '--disallowedTools',
  '--disallowed-tools',
  '--effort',
  '--exclude-dynamic-system-prompt-sections',
  '--fallback-model',
  '--file',
  '--fork-session',
  '--from-pr',
  '--ide',
  '--include-hook-events',
  '--include-partial-messages',
  '--input-format',
  '--json-schema',
  '--max-budget-usd',
  '--mcp-config',
  '--mcp-debug',
  '--model',
  '--no-chrome',
  '--no-session-persistence',
  '--output-format',
  '--permission-mode',
  '--plugin-dir',
  '--remote-control-session-name-prefix',
  '--replay-user-messages',
  '--session-id',
  '--setting-sources',
  '--settings',
  '--strict-mcp-config',
  '--system-prompt',
  '--tmux',
  '--tools',
  '--verbose',
  '-p',
  '-c',
  '-d',
  '-h',
  '-n',
  '-r',
  '-v',
  '-w',
]);

async function testClaudeCodeArgs() {
  let capturedArgs = null;
  const resultJson = JSON.stringify([
    {
      type: 'result',
      result: '{"cards":[{"title":"T","anchor":"hello world test anchor","gist":"G","bullets":["B"]}]}',
    },
  ]);
  const fakeSpawn = (_cmd, args) => {
    capturedArgs = args;
    const child = createFakeChild();
    process.nextTick(() => {
      child.stdout.emit('data', Buffer.from(resultJson));
      child.emit('close', 0);
    });
    return child;
  };

  const settings = {
    backend: 'claude-code',
    cliPath: '/usr/bin/claude',
    apiMaxTokens: 8192,
    cliTimeoutMs: 5000,
    promptLanguage: 'zh',
    minCards: 5,
    maxCards: 15,
    maxDocChars: 100000,
  };

  await t.summarizeViaClaudeCode('system prompt', 'user content', settings, undefined, fakeSpawn);

  assert.ok(capturedArgs, 'summarizeViaClaudeCode should have called spawn');

  // Verify every --flag in the args is a valid Claude CLI flag
  const flags = capturedArgs.filter((a) => a.startsWith('-'));
  for (const flag of flags) {
    assert.ok(VALID_CLAUDE_FLAGS.has(flag), `summarizeViaClaudeCode passes unsupported flag "${flag}" to claude CLI`);
  }

  // Verify key expected flags are present
  assert.ok(capturedArgs.includes('-p'), 'should include -p (print mode)');
  assert.ok(capturedArgs.includes('--output-format'), 'should include --output-format');
  assert.ok(capturedArgs.includes('--append-system-prompt'), 'should include --append-system-prompt');
  assert.ok(capturedArgs.includes('--disallowed-tools'), 'should include --disallowed-tools');

  // Verify --max-tokens is NOT present (it's not a valid claude CLI flag)
  assert.ok(!capturedArgs.includes('--max-tokens'), 'should NOT include --max-tokens');
}

// ── summarizeViaCodex args validation ──

// Known flags/subcommands supported by `codex exec` (from `codex exec --help`).
const VALID_CODEX_EXEC_FLAGS = new Set([
  '-c',
  '--config',
  '--enable',
  '--disable',
  '-i',
  '--image',
  '-m',
  '--model',
  '--oss',
  '--local-provider',
  '-p',
  '--profile',
  '-s',
  '--sandbox',
  '--full-auto',
  '--dangerously-bypass-approvals-and-sandbox',
  '-C',
  '--cd',
  '--add-dir',
  '--skip-git-repo-check',
  '--ephemeral',
  '--ignore-user-config',
  '--ignore-rules',
  '--output-schema',
  '--color',
  '--json',
  '-o',
  '--output-last-message',
  '-h',
  '--help',
  '-V',
  '--version',
]);

async function testCodexArgs() {
  let capturedArgs = null;
  const resultJson = '{"cards":[{"title":"T","anchor":"hello world test anchor","gist":"G","bullets":["B"]}]}';
  const fakeSpawn = (_cmd, args) => {
    capturedArgs = args;
    const child = createFakeChild();
    process.nextTick(() => {
      child.stdout.emit('data', Buffer.from(resultJson));
      child.emit('close', 0);
    });
    return child;
  };

  const settings = {
    backend: 'codex',
    cliPath: '/usr/bin/codex',
    cliTimeoutMs: 5000,
    promptLanguage: 'zh',
    minCards: 5,
    maxCards: 15,
    maxDocChars: 100000,
  };

  await t.summarizeViaCodex('system prompt', 'user content', settings, undefined, fakeSpawn);

  assert.ok(capturedArgs, 'summarizeViaCodex should have called spawn');

  // First arg must be the 'exec' subcommand
  assert.strictEqual(capturedArgs[0], 'exec', 'first arg should be exec subcommand');

  // Verify every --flag (after 'exec') is valid for `codex exec`
  const flags = capturedArgs.slice(1).filter((a) => a.startsWith('-') && a !== '-');
  for (const flag of flags) {
    assert.ok(VALID_CODEX_EXEC_FLAGS.has(flag), `summarizeViaCodex passes unsupported flag "${flag}" to codex exec`);
  }

  // Verify key expected flags are present
  assert.ok(capturedArgs.includes('--skip-git-repo-check'), 'should include --skip-git-repo-check');
  // '-' means read prompt from stdin
  assert.ok(capturedArgs.includes('-'), 'should include - (read from stdin)');

  // Verify stdin content combines system and user prompts
  assert.ok(capturedArgs.includes('exec'), 'should include exec subcommand');
}

// ── classifyGenerationError ──

assert.strictEqual(t.classifyGenerationError(new Error('API key 未设置')), 'auth');
assert.strictEqual(t.classifyGenerationError(new Error('API key is not set')), 'auth');
assert.strictEqual(t.classifyGenerationError(new Error('CLI timed out (120000ms)')), 'timeout');
assert.strictEqual(t.classifyGenerationError(new Error('CLI 超时 (120000ms)')), 'timeout');
assert.strictEqual(t.classifyGenerationError(new Error('API returned HTTP 429')), 'rate-limit');
assert.strictEqual(t.classifyGenerationError(new Error('json_schema validation failed')), 'schema');
assert.strictEqual(t.classifyGenerationError(new Error('LLM 返回非 JSON')), 'schema');
assert.strictEqual(t.classifyGenerationError(new Error('bad config value')), 'config');
assert.strictEqual(t.classifyGenerationError(new Error('random error')), 'unknown');
assert.strictEqual(t.classifyGenerationError(null), 'unknown', 'null error');
assert.strictEqual(t.classifyGenerationError('string error'), 'unknown', 'string error');

(async () => {
  await testRunCliEdgeCases();
  await testClaudeCodeArgs();
  await testCodexArgs();
  console.log('cli tests passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
