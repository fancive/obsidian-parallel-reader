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
  timeoutChild.pid = 4242;
  await assert.rejects(
    () => {
      // emit some bytes before timeout so we can verify the diagnostic suffix carries them
      setImmediate(() => {
        timeoutChild.stderr.emit('data', Buffer.from('boom: connection reset'));
      });
      return t.runCli('fake', [], '', 20, undefined, () => timeoutChild);
    },
    (err) => {
      assert.match(err.message, /CLI timed out \(20ms\)/, 'wall-clock timeout keeps original prefix');
      assert.match(err.message, /pid=4242/, 'timeout error carries pid');
      assert.match(err.message, /stderr=\d+B/, 'timeout error carries stderr byte count');
      assert.match(err.message, /stderr tail/, 'timeout error includes stderr tail');
      assert.match(err.message, /boom: connection reset/, 'timeout error preserves last stderr line');
      // Structured CliProcessError details (P0 #2: error UI dispatch needs typed access).
      assert.ok(err instanceof t.CliProcessError, 'wall-timeout throws CliProcessError');
      assert.strictEqual(err.details.reason, 'wall-timeout', 'wall-timeout reason set');
      assert.strictEqual(err.details.pid, 4242, 'details.pid populated');
      assert.ok(err.details.stderrBytes >= 'boom: connection reset'.length, 'details.stderrBytes utf-8 byte count');
      assert.match(err.details.stderrTail, /boom: connection reset/, 'details.stderrTail preserved');
      assert.strictEqual(err.details.timeoutMs, 20, 'details.timeoutMs reflects wall timeout');
      return true;
    },
    'runCli rejects on timeout with rich diagnostics',
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
    (err) => {
      assert.match(err.message, /CLI process streams are unavailable/, 'streams-unavailable message preserved');
      assert.ok(err instanceof t.CliProcessError, 'streams-unavailable throws CliProcessError');
      assert.strictEqual(err.details.reason, 'streams-unavailable', 'streams-unavailable reason set');
      return true;
    },
    'runCli reports unavailable stdio streams',
  );

  // Non-zero exit still throws a typed CliProcessError so dispatcher can inspect stderr.
  const exitChild = createFakeChild();
  exitChild.pid = 7373;
  const exitPromise = t.runCli('fake', [], '', 1000, undefined, () => exitChild);
  setImmediate(() => {
    exitChild.stderr.emit('data', Buffer.from('error: invalid api key'));
    exitChild.emit('close', 2, null);
  });
  await assert.rejects(
    () => exitPromise,
    (err) => {
      assert.ok(err instanceof t.CliProcessError, 'exit-nonzero throws CliProcessError');
      assert.strictEqual(err.details.reason, 'exit-nonzero', 'exit-nonzero reason set');
      assert.strictEqual(err.details.exitCode, 2, 'details.exitCode populated');
      assert.match(err.details.stderrTail, /invalid api key/, 'details.stderrTail captures auth hint');
      return true;
    },
    'runCli exposes non-zero exit code in structured details',
  );

  // Diagnostic suffix must redact secrets that show up in stderr (Bearer tokens, sk- keys, etc.)
  const secretChild = createFakeChild();
  secretChild.pid = 6363;
  await assert.rejects(
    () => {
      setImmediate(() => {
        secretChild.stderr.emit(
          'data',
          Buffer.from('Authorization: Bearer sk-ant-supersecrettoken-xyz123 failed handshake'),
        );
      });
      return t.runCli('fake', [], '', 20, undefined, () => secretChild);
    },
    (err) => {
      assert.doesNotMatch(err.message, /sk-ant-supersecrettoken-xyz123/, 'token must not appear verbatim');
      assert.match(err.message, /\[REDACTED\]/, 'redaction marker present');
      assert.match(err.message, /failed handshake/, 'non-secret context preserved');
      return true;
    },
    'runCli timeout suffix redacts secrets',
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
  assert.strictEqual(
    capturedArgs[capturedArgs.indexOf('--output-format') + 1],
    'stream-json',
    'claude output should stream JSON events',
  );
  assert.ok(capturedArgs.includes('--verbose'), 'stream-json requires --verbose in Claude CLI 2.1.131+');
  assert.ok(capturedArgs.includes('--append-system-prompt'), 'should include --append-system-prompt');
  assert.ok(capturedArgs.includes('--tools'), 'should explicitly restrict Claude tools');
  assert.strictEqual(capturedArgs[capturedArgs.indexOf('--tools') + 1], '', 'Claude tools should be disabled');
  assert.ok(capturedArgs.includes('--disallowed-tools'), 'should include --disallowed-tools');
  assert.ok(capturedArgs.includes('--no-session-persistence'), 'should avoid session persistence for plugin calls');
  assert.ok(capturedArgs.includes('--disable-slash-commands'), 'should disable slash commands for plugin calls');
  assert.ok(capturedArgs.includes('--no-chrome'), 'should suppress Claude TUI chrome');
  assert.ok(capturedArgs.includes('--strict-mcp-config'), 'should ignore user/project MCP servers');
  assert.strictEqual(
    capturedArgs[capturedArgs.indexOf('--mcp-config') + 1],
    '{"mcpServers":{}}',
    '--mcp-config must pair with an empty MCP server map',
  );
  assert.strictEqual(
    capturedArgs[capturedArgs.indexOf('--disallowed-tools') + 1],
    'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,TodoWrite,Task,LSP,NotebookEdit',
    '--disallowed-tools must list every tool that could exfiltrate or mutate',
  );
  // Ordering: -p must come before --output-format so Claude treats the run as print-mode.
  assert.ok(
    capturedArgs.indexOf('-p') < capturedArgs.indexOf('--output-format'),
    '-p must appear before --output-format',
  );
  // --verbose must accompany --output-format stream-json (Claude CLI 2.1.131+ requirement).
  // The CLI does not constrain position; we only check that --verbose is not consumed as the value of
  // another flag — i.e. it must not appear at index `--output-format` + 1 (where 'stream-json' belongs).
  const outputFmtIdx = capturedArgs.indexOf('--output-format');
  const verboseIdx = capturedArgs.indexOf('--verbose');
  assert.notStrictEqual(verboseIdx, outputFmtIdx + 1, '--verbose must not be parsed as the --output-format value');

  // Verify --max-tokens is NOT present (it's not a valid claude CLI flag)
  assert.ok(!capturedArgs.includes('--max-tokens'), 'should NOT include --max-tokens');
}

async function testClaudeCodeStreamJsonOutput() {
  const streamJson = [
    JSON.stringify({ type: 'system', subtype: 'init', tools: ['LSP'] }),
    JSON.stringify({
      type: 'result',
      result: '{"cards":[{"title":"T","anchor":"hello world test anchor","gist":"G","bullets":["B"]}]}',
    }),
    '',
  ].join('\n');
  const fakeSpawn = () => {
    const child = createFakeChild();
    process.nextTick(() => {
      child.stdout.emit('data', Buffer.from(streamJson));
      child.emit('close', 0);
    });
    return child;
  };

  const settings = {
    backend: 'claude-code',
    cliPath: '/usr/bin/claude',
    cliTimeoutMs: 5000,
    promptLanguage: 'zh',
    minCards: 5,
    maxCards: 15,
    maxDocChars: 100000,
  };

  const cards = await t.summarizeViaClaudeCode('system prompt', 'user content', settings, undefined, fakeSpawn);
  assert.strictEqual(cards.length, 1, 'claude stream-json result event is parsed');
  assert.strictEqual(cards[0].title, 'T', 'parsed card title preserved');
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

  // Verify sandbox is read-only (security: prevent prompt injection from running tools)
  const sandboxIdx = capturedArgs.indexOf('--sandbox');
  assert.ok(sandboxIdx >= 0, 'should pass --sandbox to codex exec');
  assert.strictEqual(capturedArgs[sandboxIdx + 1], 'read-only', 'sandbox value must be read-only');

  // Codex never receives --model (settings.model defaults to a Claude-name and would break codex)
  assert.ok(!capturedArgs.includes('--model'), 'codex args must not include --model (defers to codex config)');
}

async function testCodexArgsIgnoresClaudeDefaultModel() {
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

  // Even if settings.model is set (e.g. user has DEFAULT_SETTINGS.model = 'claude-sonnet-4-6'),
  // codex must NOT receive --model.
  const settings = {
    backend: 'codex',
    cliPath: '/usr/bin/codex',
    cliTimeoutMs: 5000,
    model: 'claude-sonnet-4-6',
    promptLanguage: 'zh',
    minCards: 5,
    maxCards: 15,
    maxDocChars: 100000,
  };

  await t.summarizeViaCodex('system prompt', 'user content', settings, undefined, fakeSpawn);
  assert.ok(!capturedArgs.includes('--model'), 'codex must ignore settings.model regardless of value');
}

async function testClaudeCodeArgsWithModel() {
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

  const baseSettings = {
    backend: 'claude-code',
    cliPath: '/usr/bin/claude',
    apiMaxTokens: 8192,
    cliTimeoutMs: 5000,
    promptLanguage: 'zh',
    minCards: 5,
    maxCards: 15,
    maxDocChars: 100000,
  };

  await t.summarizeViaClaudeCode('system prompt', 'user content', baseSettings, undefined, fakeSpawn);
  assert.ok(!capturedArgs.includes('--model'), 'claude args omit --model when settings.model unset');

  await t.summarizeViaClaudeCode('system', 'user', { ...baseSettings, model: 'claude-opus-4-7' }, undefined, fakeSpawn);
  const modelIdx = capturedArgs.indexOf('--model');
  assert.ok(modelIdx >= 0, 'claude should pass --model when settings.model set');
  assert.strictEqual(capturedArgs[modelIdx + 1], 'claude-opus-4-7', 'claude --model value matches settings.model');
}

// ── Claude stream-json parse resilience ──

async function runClaudeCodeWithStdout(stdoutText) {
  const fakeSpawn = () => {
    const child = createFakeChild();
    process.nextTick(() => {
      if (stdoutText) child.stdout.emit('data', Buffer.from(stdoutText));
      child.emit('close', 0);
    });
    return child;
  };
  const settings = {
    backend: 'claude-code',
    cliPath: '/usr/bin/claude',
    cliTimeoutMs: 5000,
    promptLanguage: 'zh',
    minCards: 1,
    maxCards: 15,
    maxDocChars: 100000,
  };
  return t.summarizeViaClaudeCode('system', 'user', settings, undefined, fakeSpawn);
}

async function testClaudeCodeStreamJsonResilience() {
  // B1: NDJSON with non-JSON banner line — must skip banner and still parse the result event.
  const withBanner = [
    'Claude Code 2.1.131',
    JSON.stringify({ type: 'system', subtype: 'init', tools: ['LSP'] }),
    JSON.stringify({
      type: 'result',
      result: '{"cards":[{"title":"B1","anchor":"hello world test anchor","gist":"G","bullets":["B"]}]}',
    }),
  ].join('\n');
  const b1 = await runClaudeCodeWithStdout(withBanner);
  assert.strictEqual(b1.length, 1, 'B1: banner line is skipped and result parsed');
  assert.strictEqual(b1[0].title, 'B1', 'B1: card title preserved');

  // B2: Missing result event — must throw a recognizable "no result" error (not a crash inside parser).
  // Match both zh ("没有返回结果") and en ("returned no result") so the assertion survives translate() fallback differences.
  const noResultRegex = /没有返回结果|returned no result/i;
  const onlyInit = JSON.stringify({ type: 'system', subtype: 'init', tools: [] }) + '\n';
  await assert.rejects(
    () => runClaudeCodeWithStdout(onlyInit),
    (err) => noResultRegex.test(err.message),
    'B2: missing result event throws a descriptive "no result" error',
  );

  // B3: Empty stdout — same behavior: must throw, not crash on undefined / silent success.
  await assert.rejects(
    () => runClaudeCodeWithStdout(''),
    (err) => noResultRegex.test(err.message),
    'B3: empty stdout throws a descriptive "no result" error',
  );

  // B4: Multiple result events — last one wins (claudeResultText scans in reverse).
  const twoResults = [
    JSON.stringify({
      type: 'result',
      result: '{"cards":[{"title":"FIRST","anchor":"hello world test anchor","gist":"G","bullets":["B"]}]}',
    }),
    JSON.stringify({
      type: 'result',
      result: '{"cards":[{"title":"LAST","anchor":"hello world test anchor","gist":"G","bullets":["B"]}]}',
    }),
  ].join('\n');
  const b4 = await runClaudeCodeWithStdout(twoResults);
  assert.strictEqual(b4.length, 1, 'B4: latest result event is used');
  assert.strictEqual(b4[0].title, 'LAST', 'B4: last result wins over earlier ones');

  // B5: Single-event object with `content` (not `result`) — covers the legacy fallback path
  // where claudeResultText reads `events[0].content` when no `type: result` event exists.
  const contentFallback = JSON.stringify({
    content: '{"cards":[{"title":"B5","anchor":"hello world test anchor","gist":"G","bullets":["B"]}]}',
  });
  const b5 = await runClaudeCodeWithStdout(contentFallback);
  assert.strictEqual(b5.length, 1, 'B5: events[0].content fallback parses card');
  assert.strictEqual(b5[0].title, 'B5', 'B5: content-fallback card title preserved');
}

// ── Claude verbose-missing error-path plumbing ──
// This does NOT guard the --verbose flag itself (that is locked by
// `testClaudeCodeArgs`'s `capturedArgs.includes('--verbose')` assertion, which fails
// in fake-spawn before any stderr is even simulated).
// Instead, this test simulates the *real* stderr that Claude CLI emits when
// --verbose is missing, and asserts that the error-propagation pipeline preserves
// exit code + stderr tail so the UI can render a useful diagnostic. If we ever
// rework error handling and accidentally swallow CLI stderr, this catches it.

async function testClaudeCodeVerboseRegressionCanary() {
  const fakeSpawn = () => {
    const child = createFakeChild();
    process.nextTick(() => {
      child.stderr.emit(
        'data',
        Buffer.from('Error: When using --print, --output-format=stream-json requires --verbose'),
      );
      child.emit('close', 1, null);
    });
    return child;
  };
  const settings = {
    backend: 'claude-code',
    cliPath: '/usr/bin/claude',
    cliTimeoutMs: 5000,
    promptLanguage: 'zh',
    minCards: 1,
    maxCards: 15,
    maxDocChars: 100000,
  };
  await assert.rejects(
    () => t.summarizeViaClaudeCode('system', 'user', settings, undefined, fakeSpawn),
    (err) => {
      assert.ok(err instanceof t.CliProcessError, 'canary: throws CliProcessError on exit-nonzero');
      assert.strictEqual(err.details.reason, 'exit-nonzero', 'canary: exit-nonzero reason');
      assert.strictEqual(err.details.exitCode, 1, 'canary: surfaces CLI exit code');
      assert.match(err.details.stderrTail, /requires --verbose/, 'canary: preserves verbose-flag hint in stderr');
      return true;
    },
    'Claude CLI verbose-missing stderr surfaces as a structured CliProcessError',
  );
}

// ── Codex error path ──

async function testCodexErrorPath() {
  const fakeSpawn = () => {
    const child = createFakeChild();
    process.nextTick(() => {
      child.stderr.emit('data', Buffer.from('error: not authenticated, please run codex login'));
      child.emit('close', 2, null);
    });
    return child;
  };
  const settings = {
    backend: 'codex',
    cliPath: '/usr/bin/codex',
    cliTimeoutMs: 5000,
    promptLanguage: 'zh',
    minCards: 1,
    maxCards: 15,
    maxDocChars: 100000,
  };
  await assert.rejects(
    () => t.summarizeViaCodex('system', 'user', settings, undefined, fakeSpawn),
    (err) => {
      assert.ok(err instanceof t.CliProcessError, 'codex: throws CliProcessError on exit-nonzero');
      assert.strictEqual(err.details.exitCode, 2, 'codex: exit code preserved');
      assert.match(err.details.stderrTail, /not authenticated/, 'codex: stderr tail preserves auth hint');
      return true;
    },
    'codex non-zero exit propagates structured error',
  );
}

// ── Codex args minimal contract ──
// Lock in the exact minimal arg shape: any drift means we are leaking new flags
// into a CLI that is intentionally kept minimal (no --model, no --cd, no -c).

async function testCodexArgsMinimalContract() {
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
    minCards: 1,
    maxCards: 15,
    maxDocChars: 100000,
  };
  await t.summarizeViaCodex('system', 'user', settings, undefined, fakeSpawn);

  // Exact list lock: changes here are intentional and require updating the test.
  assert.deepStrictEqual(
    capturedArgs,
    ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-'],
    'codex exec args must remain minimal (exec + skip-git + read-only sandbox + stdin marker)',
  );
}

// ── classifyGenerationError ──

assert.strictEqual(t.classifyGenerationError(new Error('API key 未设置')), 'auth');
assert.strictEqual(t.classifyGenerationError(new Error('API key is not set')), 'auth');
assert.strictEqual(t.classifyGenerationError(new Error('CLI timed out (120000ms)')), 'timeout');
assert.strictEqual(t.classifyGenerationError(new Error('CLI 超时 (120000ms)')), 'timeout');

// Structured CliProcessError short-circuits message-regex matching for deterministic reasons.
const wallTimeout = new t.CliProcessError('whatever message text', {
  reason: 'wall-timeout',
  cmd: 'claude',
  pid: 1,
  elapsedMs: 0,
  idleMs: 0,
  stdoutBytes: 0,
  stderrBytes: 0,
  stdoutTail: '',
  stderrTail: '',
  exitCode: null,
  signal: null,
  timeoutMs: 0,
});
assert.strictEqual(t.classifyGenerationError(wallTimeout), 'timeout', 'wall-timeout details → timeout kind');
const spawnFailure = new t.CliProcessError('Failed to start claude', {
  reason: 'spawn-failure',
  cmd: 'claude',
  pid: null,
  elapsedMs: 0,
  idleMs: null,
  stdoutBytes: 0,
  stderrBytes: 0,
  stdoutTail: '',
  stderrTail: '',
  exitCode: null,
  signal: null,
  timeoutMs: 0,
});
assert.strictEqual(t.classifyGenerationError(spawnFailure), 'config', 'spawn-failure details → config kind');
// exit-nonzero falls through so stderr-derived auth/rate-limit messages can still classify.
const exitWithAuthStderr = new t.CliProcessError('CLI exited with code 1\nstderr:\nerror: API key invalid', {
  reason: 'exit-nonzero',
  cmd: 'claude',
  pid: 1,
  elapsedMs: 0,
  idleMs: 0,
  stdoutBytes: 0,
  stderrBytes: 0,
  stdoutTail: '',
  stderrTail: '',
  exitCode: 1,
  signal: null,
  timeoutMs: 0,
});
assert.strictEqual(
  t.classifyGenerationError(exitWithAuthStderr),
  'auth',
  'exit-nonzero falls through so message-regex still detects auth',
);

assert.strictEqual(t.classifyGenerationError(new Error('API returned HTTP 429')), 'rate-limit');
assert.strictEqual(t.classifyGenerationError(new Error('json_schema validation failed')), 'schema');
assert.strictEqual(t.classifyGenerationError(new Error('LLM 返回非 JSON')), 'schema');
assert.strictEqual(
  t.classifyGenerationError(new Error('LLM returned non-JSON (123 chars). See console for excerpt.')),
  'schema',
  'EN non-JSON message classified as schema',
);
assert.strictEqual(
  t.classifyGenerationError(new Error('Claude CLI returned unexpected output (200 chars).')),
  'schema',
  'EN unexpected output classified as schema',
);
assert.strictEqual(
  t.classifyGenerationError(new Error('Claude CLI returned no result (0 chars).')),
  'schema',
  'EN no result classified as schema',
);
assert.strictEqual(
  t.classifyGenerationError(new Error('Claude CLI 返回了非预期输出（长度 200 字符）')),
  'schema',
  'zh unexpected-output message classified as schema',
);
assert.strictEqual(
  t.classifyGenerationError(new Error('Claude CLI 没有返回结果（长度 0 字符）')),
  'schema',
  'zh no-result message classified as schema',
);
assert.strictEqual(t.classifyGenerationError(new Error('bad config value')), 'config');
assert.strictEqual(t.classifyGenerationError(new Error('random error')), 'unknown');
assert.strictEqual(t.classifyGenerationError(null), 'unknown', 'null error');
assert.strictEqual(t.classifyGenerationError('string error'), 'unknown', 'string error');

(async () => {
  await testRunCliEdgeCases();
  await testClaudeCodeArgs();
  await testClaudeCodeStreamJsonOutput();
  await testClaudeCodeStreamJsonResilience();
  await testClaudeCodeVerboseRegressionCanary();
  await testClaudeCodeArgsWithModel();
  await testCodexArgs();
  await testCodexArgsIgnoresClaudeDefaultModel();
  await testCodexArgsMinimalContract();
  await testCodexErrorPath();
  console.log('cli tests passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
