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
    write(value) { this.written += value; },
    end() { this.ended = true; },
  };
  child.killedWith = null;
  child.kill = (signal) => { child.killedWith = signal; return true; };
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
    { key: 'cancel.md', onCancel: (handler) => { cancelHandler = handler; } },
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
  console.log('cli tests passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
