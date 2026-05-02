const { assert, t } = require('./test-setup');

const { GenerationJobAlreadyRunningError, GenerationJobCancelledError, GenerationJobManager, classifyGenerationError } =
  t;

async function testSingleFlightAndCleanup() {
  const manager = new GenerationJobManager();
  let release;
  const blocker = new Promise((resolve) => {
    release = resolve;
  });

  const first = manager.start('note.md', async (job) => {
    job.setPhase('reading');
    await blocker;
    job.setPhase('done');
    return 'ok';
  });

  assert.strictEqual(manager.isRunning('note.md'), true);
  assert.strictEqual(manager.get('note.md').phase, 'reading');
  await assert.rejects(() => manager.start('note.md', async () => 'duplicate'), GenerationJobAlreadyRunningError);

  release();
  assert.strictEqual(await first, 'ok');
  assert.strictEqual(manager.isRunning('note.md'), false);
  assert.strictEqual(manager.get('note.md'), null);
}

async function testGlobalConcurrencyLimit() {
  const manager = new GenerationJobManager(2); // max 2 concurrent
  const releases = [null, null, null, null];
  const blockers = releases.map(
    (_, i) =>
      new Promise((r) => {
        releases[i] = r;
      }),
  );
  const startedAt = [];

  const promises = ['a.md', 'b.md', 'c.md', 'd.md'].map((path, i) =>
    manager.start(path, async () => {
      startedAt.push(i);
      await blockers[i];
      return path;
    }),
  );

  // Let microtasks flush
  await new Promise((r) => setTimeout(r, 5));

  assert.strictEqual(manager.isRunning('a.md'), true, 'a is running');
  assert.strictEqual(manager.isRunning('b.md'), true, 'b is running');
  assert.strictEqual(manager.isRunning('c.md'), false, 'c is queued, not running yet');
  assert.strictEqual(manager.isRunning('d.md'), false, 'd is queued');
  assert.strictEqual(manager.isPending('c.md'), true, 'c is pending (queued)');
  assert.strictEqual(manager.waitingCount(), 2, 'two waiters queued');
  assert.deepStrictEqual(startedAt, [0, 1], 'only first 2 entered runner');

  // Release first -> c gets slot
  releases[0]();
  await promises[0];
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(manager.isRunning('c.md'), true, 'c promoted after a finishes');
  assert.strictEqual(manager.waitingCount(), 1, 'one waiter left');

  // Same-key dedup while queued: starting c again throws (without waiting)
  await assert.rejects(
    () => manager.start('d.md', async () => 'dup'),
    GenerationJobAlreadyRunningError,
    'same-key (queued) dedup throws',
  );

  releases[1]();
  releases[2]();
  releases[3]();
  await Promise.all(promises);
  assert.strictEqual(manager.waitingCount(), 0);
  assert.strictEqual(manager.isRunning('d.md'), false, 'all jobs settled');
}

async function testNoOverbookingDuringRelease() {
  // Regression for the microtask race: when a queued waiter is resolved by
  // releaseSlot(), a synchronous start() call must NOT slip past with the now-stale
  // jobs.size and bring concurrent runners above maxConcurrent.
  const manager = new GenerationJobManager(2);
  const releases = [null, null, null];
  const runnerEntered = [];
  const blockers = releases.map(
    (_, i) =>
      new Promise((r) => {
        releases[i] = r;
      }),
  );

  const a = manager.start('a.md', async () => {
    runnerEntered.push('a');
    await blockers[0];
    return 'a';
  });
  const b = manager.start('b.md', async () => {
    runnerEntered.push('b');
    await blockers[1];
    return 'b';
  });
  // c is queued (slot full); c will block too so we can observe state during transitions.
  const c = manager.start('c.md', async () => {
    runnerEntered.push('c');
    await blockers[2];
    return 'c';
  });

  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(manager.waitingCount(), 1, 'c is queued');
  assert.deepStrictEqual(runnerEntered, ['a', 'b'], 'only 2 runners entered');

  // Release a → c's waiter resolves and continuation queued. c will run and block.
  releases[0]();
  await a;
  await new Promise((r) => setTimeout(r, 5));
  // After a settles + microtasks: c is now in jobs (b + c running), runnerEntered = a,b,c
  assert.deepStrictEqual(runnerEntered, ['a', 'b', 'c'], 'c promoted after a finished');

  // Now slots are full again (b + c). New start('d.md') MUST queue, not jump in.
  const d = manager.start('d.md', async () => {
    runnerEntered.push('d');
    return 'd';
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(manager.waitingCount(), 1, 'd queued because b+c are running');
  assert.deepStrictEqual(runnerEntered, ['a', 'b', 'c'], 'd not entered while b+c running');

  releases[1]();
  releases[2]();
  await Promise.all([b, c, d]);
  assert.ok(runnerEntered.includes('d'), 'd entered eventually');
  assert.strictEqual(manager.waitingCount(), 0);
}

async function testCancelAllWaiters() {
  const manager = new GenerationJobManager(1);
  let release;
  const blocker = new Promise((r) => {
    release = r;
  });

  const running = manager.start('first.md', async () => {
    await blocker;
    return 'first';
  });

  // queued: should be cancellable
  const queued1 = manager.start('q1.md', async () => 'q1');
  const queued2 = manager.start('q2.md', async () => 'q2');

  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(manager.waitingCount(), 2, 'two queued');

  const drained = manager.cancelAllWaiters();
  assert.strictEqual(drained, 2, 'cancelAllWaiters returns drained count');
  await assert.rejects(queued1, GenerationJobCancelledError, 'q1 rejects with cancelled');
  await assert.rejects(queued2, GenerationJobCancelledError, 'q2 rejects with cancelled');

  release();
  assert.strictEqual(await running, 'first', 'running job still completes');
  assert.strictEqual(manager.waitingCount(), 0);
}

async function testCancelSignalsRunnerAndCleansUp() {
  const manager = new GenerationJobManager();
  let cancelHookCalled = false;

  const running = manager.start('cancel.md', async (job) => {
    job.onCancel(() => {
      cancelHookCalled = true;
    });
    await Promise.resolve();
    job.throwIfCancelled();
    return 'should-not-complete';
  });

  assert.strictEqual(manager.cancel('cancel.md'), true);
  await assert.rejects(running, GenerationJobCancelledError);
  assert.strictEqual(cancelHookCalled, true);
  assert.strictEqual(manager.isRunning('cancel.md'), false);
  assert.strictEqual(manager.cancel('cancel.md'), false);
}

function testErrorClassification() {
  assert.strictEqual(classifyGenerationError(new Error('API key 未设置')), 'auth');
  assert.strictEqual(classifyGenerationError(new Error('CLI 超时 (120000ms)')), 'timeout');
  assert.strictEqual(classifyGenerationError(new Error('OpenAI API 429: rate limit')), 'rate-limit');
  assert.strictEqual(classifyGenerationError(new Error('LLM 返回非 JSON')), 'schema');
  assert.strictEqual(classifyGenerationError(new Error('Model 未设置')), 'config');
  assert.strictEqual(classifyGenerationError(new Error('something else')), 'unknown');
}

(async () => {
  await testSingleFlightAndCleanup();
  await testGlobalConcurrencyLimit();
  await testNoOverbookingDuringRelease();
  await testCancelAllWaiters();
  await testCancelSignalsRunnerAndCleansUp();
  testErrorClassification();
  console.log('generation job manager tests passed');
})();
