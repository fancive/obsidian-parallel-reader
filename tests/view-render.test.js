/**
 * Component-level tests for plugin/view interaction paths.
 * These cover regressions that pure unit tests cannot catch — the bugs only
 * manifest when state on `view` (sourceFile) and runForFile options
 * (silentView) interact in specific combinations.
 */
const { assert, t } = require('./test-setup');

const { CACHE_SCHEMA_VERSION, generationFingerprint } = t;
const crypto = require('crypto');
const hashContent = (text) => crypto.createHash('sha1').update(text, 'utf8').digest('hex');

// Settings used by all tests in this file. Anthropic backend by default so we
// never accidentally hit any HTTP code path — the cache-hit path returns before
// summarizeDocument is called.
function makeSettings() {
  return {
    uiLanguage: 'en',
    backend: 'api',
    cliPath: '',
    apiProvider: 'anthropic',
    apiFormat: 'anthropic-messages',
    apiBaseUrl: 'https://api.anthropic.com/v1',
    apiKey: 'test',
    apiKeyEnvVar: '',
    apiAuthType: 'x-api-key',
    apiHeaders: '',
    apiMaxTokens: 4096,
    maxDocChars: 100000,
    maxCacheEntries: 100,
    promptLanguage: 'en',
    minCards: 5,
    maxCards: 15,
    customSystemPrompt: '',
    model: 'claude-sonnet-4-6',
    exportFolder: 'Reading/Articles',
    cliTimeoutMs: 120000,
    streaming: false,
    streamingTimeoutMs: 120000,
  };
}

function makeFakeView() {
  const calls = { renderLoading: [], renderError: [], renderEmpty: 0, loadFor: [], renderStreamingPreview: [] };
  const view = {
    sourceFile: null,
    sections: [],
    renderLoading(file, msg) {
      this.sourceFile = file;
      calls.renderLoading.push([file?.path, msg]);
    },
    renderError(file, msg) {
      this.sourceFile = file;
      calls.renderError.push([file?.path, msg]);
    },
    renderEmpty() {
      this.sourceFile = null;
      calls.renderEmpty++;
    },
    loadFor(file, sections) {
      this.sourceFile = file;
      this.sections = sections;
      calls.loadFor.push([file.path, sections.length]);
    },
    renderStreamingPreview(file, text) {
      this.sourceFile = file;
      calls.renderStreamingPreview.push([file.path, text.length]);
    },
  };
  return { view, calls };
}

function makeFakeFile(path) {
  return { path, basename: path.replace(/\.md$/, '') };
}

function makeBasePlugin(settings, { view, leaves, vaultRead } = {}) {
  const plugin = new t.ParallelReaderPlugin();
  plugin.settings = settings;
  plugin.t = (key) => key;
  plugin.jobs = new t.GenerationJobManager();
  plugin.cacheManager = {
    cache: {},
    get: () => null,
    put: async () => {},
    touch: () => null,
    delete: async () => {},
    clear: async () => {},
  };
  plugin.app = {
    workspace: {
      getLeavesOfType: () => leaves || [],
      getRightLeaf: () => null,
      revealLeaf: async () => {},
      getActiveViewOfType: () => null,
      on: () => ({}),
    },
    vault: {
      read: vaultRead || (async () => 'hello world content'),
      adapter: {},
      configDir: '.obsidian',
      getMarkdownFiles: () => [],
      getAbstractFileByPath: () => null,
      on: () => ({}),
    },
  };
  // Default getParallelView returns the supplied view if any.
  plugin.getParallelView = () => view;
  // Default getActiveView (used by activeFileStillMatches) returns null → match.
  plugin.getActiveView = () => null;
  return plugin;
}

/* ============================================================
 * shouldRender matrix: silentView × view.sourceFile state
 * Regression coverage for 1.0.13 (bug 1).
 * Uses the cache-hit code path (no LLM call) to focus on the render guard.
 * ============================================================ */
async function testShouldRender_NonSilent_FreshView() {
  const settings = makeSettings();
  const { view, calls } = makeFakeView();
  const fileA = makeFakeFile('A.md');
  const content = 'hello world content';
  const cardEntry = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    contentHash: hashContent(content),
    settingsHash: generationFingerprint(settings),
    cards: [{ title: 'T', anchor: 'hello', gist: '', bullets: [] }],
    generatedAt: '2026-01-01T00:00:00.000Z',
  };
  const plugin = makeBasePlugin(settings, { view, leaves: [{ view, setViewState: async () => {} }] });
  plugin.cacheManager.get = () => cardEntry;

  // sourceFile=null (panel never showed anything yet)
  view.sourceFile = null;
  const result = await plugin.runForFile(fileA, false);

  assert.strictEqual(result, 'cached', 'cache-hit returns cached');
  assert.strictEqual(calls.loadFor.length, 1, 'non-silent + fresh view → loadFor must fire (1.0.12 regression)');
  assert.strictEqual(calls.loadFor[0][0], 'A.md', 'loadFor passed correct file');
}

async function testShouldRender_NonSilent_DifferentFile() {
  const settings = makeSettings();
  const { view, calls } = makeFakeView();
  const fileB = makeFakeFile('B.md');
  const content = 'hello world content';
  const cardEntry = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    contentHash: hashContent(content),
    settingsHash: generationFingerprint(settings),
    cards: [{ title: 'T', anchor: 'hello', gist: '', bullets: [] }],
    generatedAt: '2026-01-01T00:00:00.000Z',
  };
  const plugin = makeBasePlugin(settings, { view, leaves: [{ view, setViewState: async () => {} }] });
  plugin.cacheManager.get = () => cardEntry;

  // panel was showing fileA, user generates fileB via hotkey
  view.sourceFile = makeFakeFile('A.md');
  await plugin.runForFile(fileB, false);

  assert.strictEqual(
    calls.loadFor.length,
    1,
    'non-silent + different sourceFile → loadFor must fire (1.0.12 regression)',
  );
  assert.strictEqual(calls.loadFor[0][0], 'B.md', 'loadFor switched to file B');
}

async function testShouldRender_Silent_DifferentFile_Skipped() {
  const settings = makeSettings();
  const { view, calls } = makeFakeView();
  const fileB = makeFakeFile('B.md');
  const content = 'hello world content';
  const cardEntry = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    contentHash: hashContent(content),
    settingsHash: generationFingerprint(settings),
    cards: [{ title: 'T', anchor: 'hello', gist: '', bullets: [] }],
    generatedAt: '2026-01-01T00:00:00.000Z',
  };
  const plugin = makeBasePlugin(settings, { view, leaves: [{ view, setViewState: async () => {} }] });
  plugin.cacheManager.get = () => cardEntry;

  // batch path: panel shows A, batch processes B → must NOT disturb panel
  view.sourceFile = makeFakeFile('A.md');
  const result = await plugin.runForFile(fileB, false, { silentView: true });

  assert.strictEqual(result, 'cached');
  assert.strictEqual(calls.loadFor.length, 0, 'silentView + different file → must NOT render (preserve user focus)');
}

async function testShouldRender_Silent_SameFile_Updates() {
  const settings = makeSettings();
  const { view, calls } = makeFakeView();
  const fileA = makeFakeFile('A.md');
  const content = 'hello world content';
  const cardEntry = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    contentHash: hashContent(content),
    settingsHash: generationFingerprint(settings),
    cards: [{ title: 'T', anchor: 'hello', gist: '', bullets: [] }],
    generatedAt: '2026-01-01T00:00:00.000Z',
  };
  const plugin = makeBasePlugin(settings, { view, leaves: [{ view, setViewState: async () => {} }] });
  plugin.cacheManager.get = () => cardEntry;

  // batch path but the panel happens to be showing the file currently being processed
  view.sourceFile = fileA;
  await plugin.runForFile(fileA, false, { silentView: true });

  assert.strictEqual(calls.loadFor.length, 1, 'silentView + same file → render IS allowed');
  assert.strictEqual(calls.loadFor[0][0], 'A.md');
}

/* ============================================================
 * toggleParallelView: open → close → open
 * Regression coverage for 1.0.13 (bug 2).
 * ============================================================ */
async function testToggleParallelView_NoLeaf_Opens() {
  const settings = makeSettings();
  let setViewStateCalled = 0;
  let revealLeafCalled = 0;
  const fakeLeaf = {
    view: { containerEl: { children: [{}, {}] } },
    setViewState: async () => {
      setViewStateCalled++;
    },
  };

  const plugin = makeBasePlugin(settings, { leaves: [] });
  plugin.app.workspace.getRightLeaf = () => fakeLeaf;
  plugin.app.workspace.revealLeaf = async () => {
    revealLeafCalled++;
  };

  await plugin.toggleParallelView();

  assert.strictEqual(setViewStateCalled, 1, 'first toggle creates leaf via setViewState');
  assert.strictEqual(revealLeafCalled, 1, 'first toggle reveals leaf');
}

async function testToggleParallelView_LeafExists_SidebarOpen_Collapses() {
  const settings = makeSettings();
  let detachCalled = 0;
  let collapseCalled = 0;
  let revealCalled = 0;
  const fakeLeaf = { detach: () => detachCalled++, view: {} };
  const plugin = makeBasePlugin(settings, { leaves: [fakeLeaf] });
  plugin.app.workspace.rightSplit = {
    collapsed: false,
    collapse: () => collapseCalled++,
  };
  plugin.app.workspace.revealLeaf = async () => {
    revealCalled++;
  };

  await plugin.toggleParallelView();

  assert.strictEqual(detachCalled, 0, 'leaf must NOT be detached (preserve tab content)');
  assert.strictEqual(collapseCalled, 1, 'expanded sidebar → collapse');
  assert.strictEqual(revealCalled, 0, 'no reveal when collapsing');
}

async function testToggleParallelView_LeafExists_SidebarCollapsed_Reveals() {
  const settings = makeSettings();
  let detachCalled = 0;
  let collapseCalled = 0;
  let revealCalled = 0;
  const fakeLeaf = { detach: () => detachCalled++, view: {} };
  const plugin = makeBasePlugin(settings, { leaves: [fakeLeaf] });
  plugin.app.workspace.rightSplit = {
    collapsed: true,
    collapse: () => collapseCalled++,
  };
  plugin.app.workspace.revealLeaf = async () => {
    revealCalled++;
  };

  await plugin.toggleParallelView();

  assert.strictEqual(detachCalled, 0, 'leaf must NOT be detached');
  assert.strictEqual(collapseCalled, 0, 'no collapse when sidebar already collapsed');
  assert.strictEqual(revealCalled, 1, 'collapsed sidebar → reveal expands it and focuses our tab');
}

async function testToggleParallelView_NoRightSplit_FallsBackToReveal() {
  const settings = makeSettings();
  let revealCalled = 0;
  const fakeLeaf = { detach: () => {}, view: {} };
  const plugin = makeBasePlugin(settings, { leaves: [fakeLeaf] });
  plugin.app.workspace.rightSplit = undefined;
  plugin.app.workspace.revealLeaf = async () => {
    revealCalled++;
  };

  await plugin.toggleParallelView();

  assert.strictEqual(revealCalled, 1, 'no right sidebar (mobile?) → fallback to revealLeaf');
}

/* ============================================================
 * refreshViewAfterCacheDelete / refreshViewAfterCacheClear
 * Regression coverage for PR2 #14 (clear cache UI not refreshed).
 * ============================================================ */
async function testRefreshViewAfterCacheDelete_MatchingFile() {
  const settings = makeSettings();
  const { view, calls } = makeFakeView();
  view.sourceFile = makeFakeFile('A.md');
  const plugin = makeBasePlugin(settings, { view });

  plugin.refreshViewAfterCacheDelete('A.md');

  assert.strictEqual(calls.renderEmpty, 1, 'view showing the cleared file → renderEmpty');
}

async function testRefreshViewAfterCacheDelete_DifferentFile() {
  const settings = makeSettings();
  const { view, calls } = makeFakeView();
  view.sourceFile = makeFakeFile('A.md');
  const plugin = makeBasePlugin(settings, { view });

  plugin.refreshViewAfterCacheDelete('B.md'); // different file

  assert.strictEqual(calls.renderEmpty, 0, 'view showing different file → must NOT renderEmpty');
}

async function testRefreshViewAfterCacheClear_AlwaysClears() {
  const settings = makeSettings();
  const { view, calls } = makeFakeView();
  view.sourceFile = makeFakeFile('A.md');
  const plugin = makeBasePlugin(settings, { view });

  plugin.refreshViewAfterCacheClear();

  assert.strictEqual(calls.renderEmpty, 1, 'clear-all → renderEmpty regardless of file');
}

/* ============================================================
 * runForFile outcome enum mapping — drives batch statistics.
 * Covers the catch-block branches that were untested before.
 * ============================================================ */
async function testRunForFile_AlreadyRunning_EarlyReturn() {
  const plugin = makeBasePlugin(makeSettings());
  plugin.jobs = { isPending: () => true, isRunning: () => true };
  const result = await plugin.runForFile(makeFakeFile('A.md'), false);
  assert.strictEqual(result, 'already-running', 'isPending=true returns early with already-running');
}

async function testRunForFile_AlreadyRunning_FromCatch() {
  const plugin = makeBasePlugin(makeSettings());
  plugin.jobs = {
    isPending: () => false,
    isRunning: () => false,
    start: async () => {
      throw new t.GenerationJobAlreadyRunningError('A.md');
    },
  };
  const result = await plugin.runForFile(makeFakeFile('A.md'), false);
  assert.strictEqual(result, 'already-running', 'GenerationJobAlreadyRunningError from start → already-running');
}

async function testRunForFile_Cancelled_FromCatch() {
  const plugin = makeBasePlugin(makeSettings());
  plugin.jobs = {
    isPending: () => false,
    isRunning: () => false,
    start: async () => {
      throw new t.GenerationJobCancelledError('A.md');
    },
  };
  const result = await plugin.runForFile(makeFakeFile('A.md'), false);
  assert.strictEqual(result, 'cancelled', 'GenerationJobCancelledError → cancelled');
}

async function testRunForFile_GenericError_FromCatch() {
  const plugin = makeBasePlugin(makeSettings());
  plugin.jobs = {
    isPending: () => false,
    isRunning: () => false,
    start: async () => {
      throw new Error('backend down');
    },
  };
  const origError = console.error;
  console.error = () => {};
  try {
    const result = await plugin.runForFile(makeFakeFile('A.md'), false);
    assert.strictEqual(result, 'error', 'plain Error → error');
  } finally {
    console.error = origError;
  }
}

async function testRunForFile_RegenerateConfirm_Cancels() {
  const plugin = makeBasePlugin(makeSettings());
  // shouldConfirmRegenerate triggers when entry has user edits — simulate via cache entry shape.
  plugin.cacheManager.get = () => ({
    schemaVersion: CACHE_SCHEMA_VERSION,
    contentHash: 'x',
    settingsHash: 'y',
    cards: [],
    generatedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z', // user edited after generation → confirm prompt
  });
  plugin.confirmRegenerateEditedCards = async () => false; // user clicks cancel
  const result = await plugin.runForFile(makeFakeFile('A.md'), true);
  assert.strictEqual(result, 'cancelled', 'user-cancelled regenerate confirm → cancelled');
}

async function testRunForFile_SkipEditConfirm_BypassesPrompt() {
  const plugin = makeBasePlugin(makeSettings());
  plugin.cacheManager.get = () => ({
    schemaVersion: CACHE_SCHEMA_VERSION,
    contentHash: 'x',
    settingsHash: 'y',
    cards: [],
    generatedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  });
  let confirmCalled = 0;
  plugin.confirmRegenerateEditedCards = async () => {
    confirmCalled++;
    return false;
  };
  // Make jobs.start succeed so we can verify confirm was skipped.
  plugin.jobs = {
    isPending: () => false,
    isRunning: () => false,
    start: async () => {
      throw new Error('downstream'); // any quick exit
    },
  };
  const origError = console.error;
  console.error = () => {};
  try {
    await plugin.runForFile(makeFakeFile('A.md'), true, { skipEditConfirm: true });
    assert.strictEqual(confirmCalled, 0, 'skipEditConfirm=true must bypass confirm prompt (batch flow)');
  } finally {
    console.error = origError;
  }
}

/* ============================================================
 * view.deleteCard / view.updateCard — cardPersistFailed path
 * Covers the case where cacheReplaceCards returns false (cache missing)
 * and verifies that user is notified of the failure.
 * ============================================================ */
async function testViewDeleteCard_PersistFails_ReturnsFalse() {
  const plugin = makeBasePlugin(makeSettings());
  let cacheReplaceCalled = null;
  plugin.cacheReplaceCards = async (path, sections) => {
    cacheReplaceCalled = { path, count: sections.length };
    return false; // simulate missing cache entry
  };

  const fakeLeaf = { view: {} };
  const view = new t.ParallelReaderView(fakeLeaf, plugin);
  view.render = () => {}; // skip DOM
  view.sourceFile = makeFakeFile('A.md');
  view.sections = [
    { title: 'a', anchor: '', gist: '', bullets: [], startLine: 0, level: 0 },
    { title: 'b', anchor: '', gist: '', bullets: [], startLine: 1, level: 0 },
  ];
  view.activeIdx = 0;

  const ok = await view.deleteCard(0);

  assert.strictEqual(ok, false, 'deleteCard returns false when cache persist fails');
  assert.deepStrictEqual(cacheReplaceCalled, { path: 'A.md', count: 1 }, 'cacheReplaceCards called with new sections');
  assert.strictEqual(view.sections.length, 1, 'view.sections is updated locally even on persist failure');
}

async function testViewDeleteCard_PersistOk_ReturnsTrue() {
  const plugin = makeBasePlugin(makeSettings());
  plugin.cacheReplaceCards = async () => true;

  const fakeLeaf = { view: {} };
  const view = new t.ParallelReaderView(fakeLeaf, plugin);
  view.render = () => {};
  view.sourceFile = makeFakeFile('A.md');
  view.sections = [
    { title: 'a', anchor: '', gist: '', bullets: [], startLine: 0, level: 0 },
    { title: 'b', anchor: '', gist: '', bullets: [], startLine: 1, level: 0 },
  ];
  view.activeIdx = 0;

  const ok = await view.deleteCard(0);
  assert.strictEqual(ok, true, 'deleteCard returns true on successful persist');
}

async function testViewUpdateCard_PersistFails_ReturnsFalse() {
  const plugin = makeBasePlugin(makeSettings());
  plugin.cacheReplaceCards = async () => false;

  const fakeLeaf = { view: {} };
  const view = new t.ParallelReaderView(fakeLeaf, plugin);
  view.render = () => {};
  view.sourceFile = makeFakeFile('A.md');
  view.sections = [{ title: 'a', anchor: '', gist: '', bullets: [], startLine: 0, level: 0 }];
  view.activeIdx = 0;

  const ok = await view.updateCard(0, { title: 'a-edited' });
  assert.strictEqual(ok, false, 'updateCard returns false on persist failure');
}

async function testRefreshViewAfterCacheClear_NoView() {
  const settings = makeSettings();
  const plugin = makeBasePlugin(settings, { view: undefined });
  plugin.getParallelView = () => undefined;

  // Must not throw when no view exists.
  plugin.refreshViewAfterCacheClear();
}

(async () => {
  await testShouldRender_NonSilent_FreshView();
  await testShouldRender_NonSilent_DifferentFile();
  await testShouldRender_Silent_DifferentFile_Skipped();
  await testShouldRender_Silent_SameFile_Updates();
  await testToggleParallelView_NoLeaf_Opens();
  await testToggleParallelView_LeafExists_SidebarOpen_Collapses();
  await testToggleParallelView_LeafExists_SidebarCollapsed_Reveals();
  await testToggleParallelView_NoRightSplit_FallsBackToReveal();
  await testRefreshViewAfterCacheDelete_MatchingFile();
  await testRefreshViewAfterCacheDelete_DifferentFile();
  await testRefreshViewAfterCacheClear_AlwaysClears();
  await testRefreshViewAfterCacheClear_NoView();
  await testRunForFile_AlreadyRunning_EarlyReturn();
  await testRunForFile_AlreadyRunning_FromCatch();
  await testRunForFile_Cancelled_FromCatch();
  await testRunForFile_GenericError_FromCatch();
  await testRunForFile_RegenerateConfirm_Cancels();
  await testRunForFile_SkipEditConfirm_BypassesPrompt();
  await testViewDeleteCard_PersistFails_ReturnsFalse();
  await testViewDeleteCard_PersistOk_ReturnsTrue();
  await testViewUpdateCard_PersistFails_ReturnsFalse();
  console.log('view-render tests passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
