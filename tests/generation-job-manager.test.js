const assert = require('assert');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'obsidian') {
    class Plugin {}
    class ItemView {}
    class PluginSettingTab {}
    class Setting {}
    class Notice {}
    class MarkdownView {}
    class TFile {}
    class Menu {}
    return {
      Plugin,
      ItemView,
      PluginSettingTab,
      Setting,
      Notice,
      MarkdownView,
      TFile,
      Menu,
      MarkdownRenderer: { render: async () => {} },
      requestUrl: async () => ({ status: 200, json: {}, text: '{}' }),
      setIcon: () => {},
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const {
  GenerationJobAlreadyRunningError,
  GenerationJobCancelledError,
  GenerationJobManager,
  classifyGenerationError,
} = require('../main.js').__test;

async function testSingleFlightAndCleanup() {
  const manager = new GenerationJobManager();
  let release;
  const blocker = new Promise(resolve => { release = resolve; });

  const first = manager.start('note.md', async job => {
    job.setPhase('reading');
    await blocker;
    job.setPhase('done');
    return 'ok';
  });

  assert.strictEqual(manager.isRunning('note.md'), true);
  assert.strictEqual(manager.get('note.md').phase, 'reading');
  await assert.rejects(
    () => manager.start('note.md', async () => 'duplicate'),
    GenerationJobAlreadyRunningError
  );

  release();
  assert.strictEqual(await first, 'ok');
  assert.strictEqual(manager.isRunning('note.md'), false);
  assert.strictEqual(manager.get('note.md'), null);
}

async function testCancelSignalsRunnerAndCleansUp() {
  const manager = new GenerationJobManager();
  let cancelHookCalled = false;

  const running = manager.start('cancel.md', async job => {
    job.onCancel(() => { cancelHookCalled = true; });
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
  await testCancelSignalsRunnerAndCleansUp();
  testErrorClassification();
  console.log('generation job manager tests passed');
})();
