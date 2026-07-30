/**
 * Component-level tests for plugin/view interaction paths.
 * These cover regressions that pure unit tests cannot catch — the bugs only
 * manifest when state on `view` (sourceFile) and runForFile options
 * (silentView) interact in specific combinations.
 */
const { assert, t } = require('./test-setup');
const { takeTooltips, takeNotices } = require('./obsidian-mock.mjs');

const { CACHE_SCHEMA_VERSION, generationFingerprint } = t;
const crypto = require('crypto');
const hashContent = (text) => crypto.createHash('sha1').update(text, 'utf8').digest('hex');

// The real ParallelReaderView.renderCard click handler reads `window.getSelection()`
// (to skip clicks that are actually text-selection drags). Node has no `window`;
// Obsidian's Electron renderer does. Polyfill just enough to exercise the handler.
if (typeof globalThis.window === 'undefined') {
  globalThis.window = { getSelection: () => ({ toString: () => '' }) };
}

/**
 * Minimal fake DOM element supporting the subset of Obsidian's HTMLElement
 * extensions (createDiv/createEl/createSpan/addClass/removeClass/dataset/
 * addEventListener) that ParallelReaderView's render path uses. Obsidian's real
 * mock in obsidian-mock.mjs only stubs `containerEl.children` as plain `{}`
 * objects, which is enough for tests that stub `view.render`, but the S3
 * card-highlight regressions only manifest through a REAL render (is-active
 * classes, real card element identity), so this fixture drives that render.
 */
class FakeEl {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this._classes = new Set();
    this.dataset = {};
    this._listeners = {};
    this.textContent = '';
  }
  createDiv(opts = {}) {
    return this._append('div', opts);
  }
  createEl(tag, opts = {}) {
    return this._append(tag, opts);
  }
  createSpan(opts = {}) {
    return this._append('span', opts);
  }
  _append(tag, opts) {
    const el = new FakeEl(tag);
    if (opts.cls) el.addClass(opts.cls);
    if (opts.text != null) el.textContent = opts.text;
    if (opts.title) el.title = opts.title;
    this.children.push(el);
    return el;
  }
  empty() {
    this.children = [];
  }
  addClass(cls) {
    this._classes.add(cls);
  }
  removeClass(cls) {
    this._classes.delete(cls);
  }
  hasClass(cls) {
    return this._classes.has(cls);
  }
  addEventListener(type, handler) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(handler);
  }
  removeEventListener(type, handler) {
    const arr = this._listeners[type];
    if (!arr) return;
    const i = arr.indexOf(handler);
    if (i >= 0) arr.splice(i, 1);
  }
  dispatch(type, evtOverrides = {}) {
    const handlers = this._listeners[type] || [];
    const e = { target: this, preventDefault() {}, stopPropagation() {}, ...evtOverrides };
    for (const h of handlers) h(e);
  }
  scrollIntoView(opts) {
    this.lastScrollIntoView = opts;
  }
  querySelector() {
    return null;
  }
  setAttr(k, v) {
    this[k] = v;
  }
  focus() {}
}

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

/** Lets every pending microtask (and the macrotask turn after it) drain. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

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
 * S8 (hole 1): plugin.cacheClear() — the method the Settings tab's "Clear all
 * cache" button calls — used to be a bare `return this.cacheManager.clear()`
 * delegation with no view refresh, while the functionally identical
 * `clear-all` COMMAND always called refreshViewAfterCacheClear(). That split
 * left dead cards on screen when the cache was cleared from Settings. Both
 * entry points must now behave identically.
 * ============================================================ */
async function testCacheClear_RefreshesView_LikeClearAllCommand() {
  const settings = makeSettings();
  const { view, calls } = makeFakeView();
  view.sourceFile = makeFakeFile('A.md');
  const plugin = makeBasePlugin(settings, { view });
  let cacheManagerClearCalls = 0;
  plugin.cacheManager.clear = async () => {
    cacheManagerClearCalls++;
  };

  await plugin.cacheClear();

  assert.strictEqual(cacheManagerClearCalls, 1, 'cacheClear must clear the underlying cache');
  assert.strictEqual(
    calls.renderEmpty,
    1,
    'cacheClear must refresh the view -- the Settings tab button used to skip this and leave dead cards on screen',
  );
}

async function testCacheClear_NoView_DoesNotThrow() {
  const settings = makeSettings();
  const plugin = makeBasePlugin(settings, { view: undefined });
  plugin.getParallelView = () => undefined;
  plugin.cacheManager.clear = async () => {};

  // Must not throw when no panel is open.
  await plugin.cacheClear();
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
 * S8 (hole 2): the cache write must be awaited BEFORE any visible state is
 * mutated. A failed (returns false) or throwing write must leave
 * `sections`/`activeIdx` byte-for-byte as they were, and must NOT call
 * render() -- otherwise the user sees the card vanish, a failure toast, and
 * then a silent resurrection the next time the file is opened (S8, hole 2).
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
  let renderCalls = 0;
  view.render = () => {
    renderCalls++;
  };
  view.sourceFile = makeFakeFile('A.md');
  const originalSections = [
    { title: 'a', anchor: '', gist: '', bullets: [], startLine: 0, level: 0 },
    { title: 'b', anchor: '', gist: '', bullets: [], startLine: 1, level: 0 },
  ];
  view.sections = originalSections;
  view.activeIdx = 1;

  const ok = await view.deleteCard(0);

  assert.strictEqual(ok, false, 'deleteCard returns false when cache persist fails');
  assert.deepStrictEqual(
    cacheReplaceCalled,
    { path: 'A.md', count: 1 },
    'cacheReplaceCards is still called with the WOULD-BE next sections, before any commit',
  );
  assert.strictEqual(
    view.sections,
    originalSections,
    'view.sections must be the exact same reference (untouched) when persist fails -- no removed-card flash',
  );
  assert.strictEqual(view.sections.length, 2, 'card must NOT disappear from view state when persist fails');
  assert.strictEqual(view.activeIdx, 1, 'activeIdx must be untouched when persist fails');
  assert.strictEqual(renderCalls, 0, 'render() must not run on a failed write');
}

async function testViewDeleteCard_PersistThrows_RollsBack() {
  const plugin = makeBasePlugin(makeSettings());
  plugin.cacheReplaceCards = async () => {
    throw new Error('disk write failed');
  };

  const fakeLeaf = { view: {} };
  const view = new t.ParallelReaderView(fakeLeaf, plugin);
  let renderCalls = 0;
  view.render = () => {
    renderCalls++;
  };
  view.sourceFile = makeFakeFile('A.md');
  const originalSections = [{ title: 'a', anchor: '', gist: '', bullets: [], startLine: 0, level: 0 }];
  view.sections = originalSections;
  view.activeIdx = 0;

  const origError = console.error;
  console.error = () => {};
  let ok;
  try {
    ok = await view.deleteCard(0);
  } finally {
    console.error = origError;
  }

  assert.strictEqual(ok, false, 'deleteCard swallows a throwing cacheReplaceCards and returns false');
  assert.strictEqual(view.sections, originalSections, 'sections must be untouched when cacheReplaceCards throws');
  assert.strictEqual(view.activeIdx, 0, 'activeIdx must be untouched when cacheReplaceCards throws');
  assert.strictEqual(renderCalls, 0, 'render() must not run when the write throws');
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
  assert.strictEqual(view.sections.length, 1, 'sections commit to the deleted state once persist succeeds');
}

async function testViewUpdateCard_PersistFails_ReturnsFalse() {
  const plugin = makeBasePlugin(makeSettings());
  plugin.cacheReplaceCards = async () => false;

  const fakeLeaf = { view: {} };
  const view = new t.ParallelReaderView(fakeLeaf, plugin);
  let renderCalls = 0;
  view.render = () => {
    renderCalls++;
  };
  view.sourceFile = makeFakeFile('A.md');
  const originalSections = [{ title: 'a', anchor: '', gist: '', bullets: [], startLine: 0, level: 0 }];
  view.sections = originalSections;
  view.activeIdx = 0;

  const ok = await view.updateCard(0, { title: 'a-edited' });

  assert.strictEqual(ok, false, 'updateCard returns false on persist failure');
  assert.strictEqual(view.sections, originalSections, 'sections must be untouched when persist fails');
  assert.strictEqual(view.sections[0].title, 'a', 'edited title must NOT apply when persist fails');
  assert.strictEqual(renderCalls, 0, 'render() must not run on a failed write');
}

async function testViewUpdateCard_PersistThrows_RollsBack() {
  const plugin = makeBasePlugin(makeSettings());
  plugin.cacheReplaceCards = async () => {
    throw new Error('disk write failed');
  };

  const fakeLeaf = { view: {} };
  const view = new t.ParallelReaderView(fakeLeaf, plugin);
  view.render = () => {};
  view.sourceFile = makeFakeFile('A.md');
  const originalSections = [{ title: 'a', anchor: '', gist: '', bullets: [], startLine: 0, level: 0 }];
  view.sections = originalSections;
  view.activeIdx = 0;

  const origError = console.error;
  console.error = () => {};
  let ok;
  try {
    ok = await view.updateCard(0, { title: 'a-edited' });
  } finally {
    console.error = origError;
  }

  assert.strictEqual(ok, false, 'updateCard swallows a throwing cacheReplaceCards and returns false');
  assert.strictEqual(view.sections, originalSections, 'sections untouched when cacheReplaceCards throws');
  assert.strictEqual(view.sections[0].title, 'a', 'edited title must NOT apply when the write throws');
}

/* ============================================================
 * Review P1 (src/view.ts): a card write that COMPLETES after the user switched
 * notes must not repaint the newly opened note with the previous note's cards.
 * `cacheReplaceCards` is awaited, and the view can change file underneath that
 * await; the cache write must still be honored, but the VISIBLE state may only
 * be committed while the view still represents the note the edit started on.
 * ============================================================ */
function makeSection(title, startLine) {
  return { title, anchor: '', gist: '', bullets: [], startLine, level: 0 };
}

async function testViewDeleteCard_FileSwitchedMidWrite_DoesNotRepaintNewNote() {
  const plugin = makeBasePlugin(makeSettings());
  const writeCalls = [];
  let resolveWrite = null;
  plugin.cacheReplaceCards = (path, sections) => {
    writeCalls.push([path, sections.length]);
    return new Promise((resolve) => {
      resolveWrite = resolve;
    });
  };

  const view = new t.ParallelReaderView({ view: {} }, plugin);
  let renderCalls = 0;
  view.render = () => {
    renderCalls++;
  };
  view.sourceFile = makeFakeFile('A.md');
  view.sections = [makeSection('a1', 0), makeSection('a2', 5)];
  view.activeIdx = 1;

  // Card mutations are serialized on a per-view queue, so the write starts on the next
  // microtask rather than synchronously; let it start before switching notes, which is
  // what this test is about ("the write is still in flight").
  const pending = view.deleteCard(0);
  await tick();

  // The user opens B.md while the delete's cache write is still in flight.
  const fileB = makeFakeFile('B.md');
  const sectionsB = [makeSection('b1', 0)];
  view.sourceFile = fileB;
  view.sections = sectionsB;
  view.activeIdx = -1;
  const rendersBeforeWriteLands = renderCalls;

  resolveWrite(true);
  const ok = await pending;

  assert.deepStrictEqual(writeCalls, [['A.md', 1]], 'the delete must still be persisted for the note it started on');
  assert.strictEqual(ok, true, 'the delete itself succeeded — it was persisted');
  assert.strictEqual(
    view.sections,
    sectionsB,
    "a write that lands after a file switch must not paint A.md's remaining cards into B.md",
  );
  assert.strictEqual(
    view.activeIdx,
    -1,
    "B.md's active-card state must not be overwritten by A.md's post-delete index",
  );
  assert.strictEqual(renderCalls, rendersBeforeWriteLands, 'a write that lands after a file switch must not repaint');
}

async function testViewUpdateCard_FileSwitchedMidWrite_DoesNotRepaintNewNote() {
  const plugin = makeBasePlugin(makeSettings());
  let resolveWrite = null;
  plugin.cacheReplaceCards = () =>
    new Promise((resolve) => {
      resolveWrite = resolve;
    });

  const view = new t.ParallelReaderView({ view: {} }, plugin);
  let renderCalls = 0;
  view.render = () => {
    renderCalls++;
  };
  view.sourceFile = makeFakeFile('A.md');
  view.sections = [makeSection('a1', 0)];

  // See the delete variant above: let the queued write start before switching notes.
  const pending = view.updateCard(0, { title: 'a1-edited' });
  await tick();

  const sectionsB = [makeSection('b1', 0)];
  view.sourceFile = makeFakeFile('B.md');
  view.sections = sectionsB;
  const rendersBeforeWriteLands = renderCalls;

  resolveWrite(true);
  await pending;

  assert.strictEqual(view.sections, sectionsB, "B.md must keep its own cards after A.md's edit lands");
  assert.strictEqual(view.sections[0].title, 'b1', "A.md's edited title must not leak into B.md");
  assert.strictEqual(renderCalls, rendersBeforeWriteLands, 'a write that lands after a file switch must not repaint');
}

/* ============================================================
 * Round-3 review P1 (src/view.ts): two card mutations issued before the first one's
 * write lands used to compute their replacement arrays from the same untouched
 * `sections`, so the later (stale) payload silently overwrote the earlier successful
 * one — and BOTH reported success. Deleting cards 0 and 1 wrote `[b,c]` and then
 * `[a,c]`, ending at `[a,c]` instead of `[c]`.
 *
 * Serializing the CACHE writes cannot fix this: by the time a write is ordered, its
 * payload was already computed from a stale snapshot. The computation and the
 * persistence have to share one ordering boundary, in the view.
 *
 * The fake below models the real CacheManager: writes are asynchronous, serialized, and
 * the last payload to arrive is what remains on disk.
 * ============================================================ */
function makeSerializedCardStore(view, { failNthWrite = 0 } = {}) {
  const store = { writes: [], disk: null };
  view.plugin.cacheReplaceCards = async (path, sections) => {
    const titles = sections.map((s) => s.title);
    store.writes.push([path, titles]);
    const attempt = store.writes.length;
    await tick(); // a real write is asynchronous
    if (attempt === failNthWrite) return false;
    store.disk = titles;
    return true;
  };
  return store;
}

function makeThreeCardView(plugin) {
  const view = new t.ParallelReaderView({ view: {} }, plugin);
  view.containerEl = { children: [{}, new FakeEl('div')] };
  view.loadFor(makeFakeFile('A.md'), [makeSection('a', 0), makeSection('b', 10), makeSection('c', 20)], false);
  return view;
}

const titlesOf = (sections) => sections.map((s) => s.title);

async function testConcurrentDeletes_BothApply_NeitherIsOverwritten() {
  const plugin = makeBasePlugin(makeSettings());
  const view = makeThreeCardView(plugin);
  const store = makeSerializedCardStore(view);

  // The user deletes the first card and then the second card of the list they are
  // looking at, before the first write has landed.
  const [firstOk, secondOk] = await Promise.all([view.deleteCard(0), view.deleteCard(1)]);

  assert.strictEqual(firstOk, true, 'the first delete succeeded');
  assert.strictEqual(secondOk, true, 'the second delete succeeded');
  assert.deepStrictEqual(
    store.disk,
    ['c'],
    'both deletes must survive: the second must be computed from the first’s result, not from a stale snapshot ' +
      'that silently resurrects the card the first one deleted',
  );
  assert.deepStrictEqual(titlesOf(view.sections), ['c'], 'the panel must show what was actually persisted');
}

async function testConcurrentUpdateAndDelete_BothApply() {
  const plugin = makeBasePlugin(makeSettings());
  const view = makeThreeCardView(plugin);
  const store = makeSerializedCardStore(view);

  const [updated, deleted] = await Promise.all([view.updateCard(0, { title: 'a-edited' }), view.deleteCard(1)]);

  assert.strictEqual(updated, true, 'the edit succeeded');
  assert.strictEqual(deleted, true, 'the delete succeeded');
  assert.deepStrictEqual(
    store.disk,
    ['a-edited', 'c'],
    'a delete racing an edit of a different card must not roll the edit back',
  );
  assert.deepStrictEqual(titlesOf(view.sections), ['a-edited', 'c'], 'the panel must show what was actually persisted');
}

/**
 * The same overwrite, arriving through the file-switch door: both deletes are requested
 * while A.md is showing, but the user opens B.md while the first write is in flight. The
 * queued second mutation can no longer read A's state off the view — it must inherit it
 * from the link that ran before it, or it recomputes from the pre-first-delete snapshot
 * and resurrects the deleted card on disk.
 */
async function testConcurrentDeletes_FileSwitchesMidQueue_SecondInheritsTheFirstsResult() {
  const plugin = makeBasePlugin(makeSettings());
  const view = makeThreeCardView(plugin);
  const writes = [];
  let disk = null;
  let releaseFirstWrite = null;
  plugin.cacheReplaceCards = async (path, sections) => {
    const titles = sections.map((s) => s.title);
    writes.push([path, titles]);
    if (writes.length === 1) {
      await new Promise((resolve) => {
        releaseFirstWrite = resolve;
      });
    } else {
      await tick();
    }
    disk = titles;
    return true;
  };

  const first = view.deleteCard(0);
  const second = view.deleteCard(1);
  await tick(); // the first delete's write is now in flight

  // The user opens B.md before A.md's first write lands.
  view.loadFor(makeFakeFile('B.md'), [makeSection('b1', 0)], false);
  releaseFirstWrite();
  const [firstOk, secondOk] = await Promise.all([first, second]);

  assert.strictEqual(firstOk, true, 'the first delete was persisted for the note it started on');
  assert.strictEqual(secondOk, true, 'so was the second');
  assert.deepStrictEqual(
    writes,
    [
      ['A.md', ['b', 'c']],
      ['A.md', ['c']],
    ],
    'both writes target A.md, and the second payload is computed from the first’s result',
  );
  assert.deepStrictEqual(disk, ['c'], 'A.md ends with both deletes applied, not with the first one undone');
  assert.deepStrictEqual(titlesOf(view.sections), ['b1'], 'and neither write may repaint B.md');
}

async function testConcurrentDeletes_SecondWriteFails_RollsBackOnlyItself() {
  const plugin = makeBasePlugin(makeSettings());
  const view = makeThreeCardView(plugin);
  const store = makeSerializedCardStore(view, { failNthWrite: 2 });

  const [firstOk, secondOk] = await Promise.all([view.deleteCard(0), view.deleteCard(1)]);

  assert.strictEqual(firstOk, true, 'the first delete persisted and must still report success');
  assert.strictEqual(secondOk, false, 'the delete whose write failed must report failure');
  assert.deepStrictEqual(store.disk, ['b', 'c'], 'disk keeps the first delete and nothing of the failed second');
  assert.deepStrictEqual(
    titlesOf(view.sections),
    ['b', 'c'],
    'a failed mutation must roll back only itself — it may not undo the mutation that already committed',
  );
}

/* ============================================================
 * Cross-model review P3 (src/view.ts:649): a superseded same-card mutation must still
 * fail CLOSED — that behavior is correct and documented, and these tests don't touch
 * it — but it used to fail SILENTLY, with no feedback at all, unlike the write-failure
 * path (`cardPersistFailed`). Both tests below drive two mutations at the SAME card
 * (same index, before the first's write lands, so both capture the identical target
 * object) and assert the superseded one now surfaces `cardMutationSuperseded`.
 * ============================================================ */
async function testViewDeleteCard_SupersededBySameCardMutation_ShowsNoticeAndReturnsFalse() {
  const plugin = makeBasePlugin(makeSettings());
  const view = makeThreeCardView(plugin); // A.md showing [a, b, c]
  const store = makeSerializedCardStore(view);
  takeNotices();

  // Both calls fire before view.sections has changed, so both capture the SAME `a`
  // card object as their target — the documented same-card race, not a different-card one.
  const [firstOk, secondOk] = await Promise.all([view.deleteCard(0), view.deleteCard(0)]);

  assert.strictEqual(firstOk, true, 'the first delete of card `a` succeeds');
  assert.strictEqual(
    secondOk,
    false,
    'the second delete targets the SAME card by identity; once the first delete removes it, the second ' +
      'can no longer find it and must fail closed (documented limitation — must stay false)',
  );
  assert.deepStrictEqual(store.writes, [['A.md', ['b', 'c']]], 'the superseded delete must not write at all');
  assert.deepStrictEqual(titlesOf(view.sections), ['b', 'c'], 'only the first delete is reflected in the panel');

  const notices = takeNotices().map((n) => n.message);
  assert.deepStrictEqual(
    notices,
    ['cardDeleted', 'cardMutationSuperseded'],
    'the superseded delete must now surface feedback instead of failing silently, without reusing ' +
      '`cardPersistFailed` (nothing failed to persist here — the mutation was superseded)',
  );
}

async function testViewUpdateCard_SupersededBySameCardMutation_ShowsNoticeAndReturnsFalse() {
  const plugin = makeBasePlugin(makeSettings());
  const view = makeThreeCardView(plugin); // A.md showing [a, b, c]
  const store = makeSerializedCardStore(view);
  takeNotices();

  // Same race as the delete test above, but for updateCard: `updateCardAt` replaces the
  // edited card with a NEW object (never mutates in place), so the second edit's captured
  // target is gone from `sections` by the time it runs, even though it targeted the same index.
  const [firstOk, secondOk] = await Promise.all([
    view.updateCard(0, { title: 'a-edited' }),
    view.updateCard(0, { title: 'a-edited-again' }),
  ]);

  assert.strictEqual(firstOk, true, 'the first edit of card `a` succeeds');
  assert.strictEqual(
    secondOk,
    false,
    'the second edit targets the SAME pre-edit card object by identity; it is no longer in the ' +
      'authoritative array after the first edit replaces it, so it must fail closed',
  );
  assert.deepStrictEqual(store.writes, [['A.md', ['a-edited', 'b', 'c']]], 'the superseded edit must not write at all');
  assert.deepStrictEqual(titlesOf(view.sections), ['a-edited', 'b', 'c'], 'only the first edit lands');

  const notices = takeNotices().map((n) => n.message);
  assert.deepStrictEqual(
    notices,
    ['cardSaved', 'cardMutationSuperseded'],
    'the superseded edit must now surface feedback instead of failing silently',
  );
}

/* ============================================================
 * Round-4 review P1 (src/view.ts): the queue's authoritative "what does this note
 * look like now" state must be kept PER NOTE.
 *
 * A single global slot can only remember one note at a time, so an INTERLEAVED queue
 * (A → B → A) loses A's state the moment B's mutation records its own: the second A
 * mutation then finds a slot belonging to B, falls back to the snapshot the user was
 * looking at, and writes a payload computed from A's PRE-delete list — resurrecting a
 * card that the first mutation had already successfully deleted, while both report
 * success.
 * ============================================================ */
function makeInterleavedCardStore(plugin, initialDisk) {
  const store = { writes: [], disk: { ...initialDisk } };
  plugin.cacheReplaceCards = async (path, sections) => {
    const titles = sections.map((s) => s.title);
    store.writes.push([path, titles]);
    await tick(); // a real write is asynchronous
    store.disk[path] = titles;
    return true;
  };
  return store;
}

async function testInterleavedMutations_ABA_SecondANoteMutationDoesNotResurrectADeletedCard() {
  const plugin = makeBasePlugin(makeSettings());
  const view = makeThreeCardView(plugin); // A.md showing [a, b, c]
  const cardsA = view.sections;
  const store = makeInterleavedCardStore(plugin, { 'A.md': ['a', 'b', 'c'], 'B.md': ['x', 'y'] });

  // 1. On A.md the user deletes card `a`.
  const first = view.deleteCard(0);

  // 2. Before that write lands the user opens B.md and deletes a card there.
  const sectionsB = [makeSection('x', 0), makeSection('y', 10)];
  view.loadFor(makeFakeFile('B.md'), sectionsB, false);
  const second = view.deleteCard(0);

  // 3. Still before anything has landed, the user goes back to A.md. Its cache entry has
  //    not been rewritten yet, so the panel shows the same pre-delete list — and the user
  //    deletes card `b` from it.
  view.loadFor(makeFakeFile('A.md'), cardsA, false);
  const third = view.deleteCard(1);

  // 4. ...and switches back to B.md before the queue drains, so the last A mutation runs
  //    with the panel pointed somewhere else. This is the only door through which the
  //    queue's own record of A.md can be consulted.
  view.loadFor(makeFakeFile('B.md'), sectionsB, false);

  const [firstOk, secondOk, thirdOk] = await Promise.all([first, second, third]);

  assert.deepStrictEqual(
    store.disk['A.md'],
    ['c'],
    'the second A.md mutation must be computed from the first A.md mutation’s result, not from the ' +
      'stale pre-delete snapshot — a B.md mutation queued between them may not resurrect card `a`',
  );
  assert.deepStrictEqual(
    store.writes,
    [
      ['A.md', ['b', 'c']],
      ['B.md', ['y']],
      ['A.md', ['c']],
    ],
    'each write targets its own note and inherits that note’s own latest authoritative array',
  );
  assert.deepStrictEqual(store.disk['B.md'], ['y'], 'B.md keeps its own delete');
  assert.strictEqual(firstOk, true, 'the first A.md delete succeeded');
  assert.strictEqual(secondOk, true, 'the B.md delete succeeded');
  assert.strictEqual(thirdOk, true, 'the second A.md delete succeeded');
  assert.deepStrictEqual(titlesOf(view.sections), ['y'], 'and no A.md write may repaint B.md');
  assert.strictEqual(
    view.mutationStateByPath.size,
    0,
    'per-note mutation state must be dropped once no mutation for that note is queued — it may not ' +
      'accumulate one entry per note touched for the lifetime of the session',
  );
}

/**
 * The same interleaving, but the return to A.md re-resolves the cards from cache, so the
 * panel holds equal-but-not-identical card objects. The inherited array is still the right
 * base: the card the user acted on is not in it by identity, so the mutation aborts and
 * reports failure — exactly like the documented same-card race. What it must NOT do is fall
 * back to a positional edit or to the stale snapshot, either of which un-deletes card `a`.
 */
async function testInterleavedMutations_ABA_ReResolvedCardsAbortRatherThanResurrect() {
  const plugin = makeBasePlugin(makeSettings());
  const view = makeThreeCardView(plugin); // A.md showing [a, b, c]
  const store = makeInterleavedCardStore(plugin, { 'A.md': ['a', 'b', 'c'], 'B.md': ['x', 'y'] });

  const first = view.deleteCard(0);

  const sectionsB = [makeSection('x', 0), makeSection('y', 10)];
  view.loadFor(makeFakeFile('B.md'), sectionsB, false);
  const second = view.deleteCard(0);

  // Back on A.md, but through a fresh cache resolve: same content, new objects.
  view.loadFor(makeFakeFile('A.md'), [makeSection('a', 0), makeSection('b', 10), makeSection('c', 20)], false);
  const third = view.deleteCard(1);

  view.loadFor(makeFakeFile('B.md'), sectionsB, false);

  const [firstOk, secondOk, thirdOk] = await Promise.all([first, second, third]);

  assert.strictEqual(firstOk, true, 'the first A.md delete succeeded');
  assert.strictEqual(secondOk, true, 'the B.md delete succeeded');
  assert.strictEqual(thirdOk, false, 'a mutation whose target is absent from the authoritative array reports failure');
  assert.deepStrictEqual(
    store.disk['A.md'],
    ['b', 'c'],
    'the aborted mutation must leave A.md exactly as the first delete left it — no resurrection of `a`',
  );
  assert.deepStrictEqual(
    store.writes,
    [
      ['A.md', ['b', 'c']],
      ['B.md', ['y']],
    ],
    'an aborted mutation must not write at all',
  );
}

/* ============================================================
 * Review P1 (main.ts): initial editor→card synchronization.
 * bindScrollSync() only INSTALLS the scroll listener. Because loadFor() resets
 * activeIdx to -1 whenever the file changes, opening or switching to a note with
 * cached cards left every card unhighlighted until the user physically scrolled.
 * Both entry points (binding the listener, and loading a file into the panel)
 * must run the synchronization themselves — with no scroll event in sight.
 * ============================================================ */
function makeFakeEditorScrollDom() {
  const listeners = [];
  return {
    listeners,
    addEventListener(type, cb, options) {
      listeners.push({ type, cb, options });
    },
    removeEventListener(type, cb) {
      const i = listeners.findIndex((l) => l.type === type && l.cb === cb);
      if (i >= 0) listeners.splice(i, 1);
    },
    getBoundingClientRect: () => ({ top: 0, height: 400, left: 0 }),
  };
}

/** Fake MarkdownView whose viewport top resolves to `topLineNumber` (1-based, as CodeMirror reports). */
function makeFakeEditorMdView(file, scrollDom, topLineNumber) {
  return {
    file,
    editor: {
      cm: {
        scrollDOM: scrollDom,
        posAtCoords: () => 1,
        state: { doc: { lineAt: () => ({ number: topLineNumber }) } },
      },
    },
    contentEl: { querySelector: () => null },
  };
}

function testBindScrollSync_SyncsActiveCardWithoutAnyScrollEvent() {
  const plugin = makeBasePlugin(makeSettings());
  const view = new t.ParallelReaderView({ view: {} }, plugin);
  view.containerEl = { children: [{}, new FakeEl('div')] };
  plugin.getParallelView = () => view;

  const file = makeFakeFile('A.md');
  view.loadFor(file, [makeSection('c0', 0), makeSection('c1', 10), makeSection('c2', 20)], false);
  assert.strictEqual(view.activeIdx, -1, 'sanity: a note that was just loaded starts with no active card');

  const scrollDom = makeFakeEditorScrollDom();
  plugin.getActiveView = () => makeFakeEditorMdView(file, scrollDom, 11); // viewport top = line index 10

  plugin.bindScrollSync();

  assert.strictEqual(scrollDom.listeners.length, 1, 'sanity: binding attaches exactly one scroll listener');
  assert.strictEqual(
    view.activeIdx,
    1,
    'binding scroll-sync must synchronize the active card immediately — the user should not have to scroll to get a highlight',
  );
  assert.ok(view.cards[1].hasClass('is-active'), 'the synchronized card must carry is-active');
}

async function testSyncViewToFile_SyncsActiveCardWithoutAnyScrollEvent() {
  const settings = makeSettings();
  const content = Array.from({ length: 30 }, (_, i) => (i === 2 ? 'Alpha' : i === 12 ? 'Beta' : `filler ${i}`)).join(
    '\n',
  );
  const plugin = makeBasePlugin(settings);
  const view = new t.ParallelReaderView({ view: {} }, plugin);
  view.containerEl = { children: [{}, new FakeEl('div')] };
  plugin.app.workspace.getLeavesOfType = () => [{ view }];
  plugin.getParallelView = () => view;
  plugin.app.vault.read = async () => content;
  plugin.cacheManager.get = () => ({
    schemaVersion: CACHE_SCHEMA_VERSION,
    contentHash: hashContent(content),
    settingsHash: generationFingerprint(settings),
    cards: [
      { title: 'Alpha', anchor: 'Alpha', gist: '', bullets: [] },
      { title: 'Beta', anchor: 'Beta', gist: '', bullets: [] },
    ],
    generatedAt: '2026-01-01T00:00:00.000Z',
  });

  const file = makeFakeFile('B.md');
  plugin.getActiveView = () => makeFakeEditorMdView(file, makeFakeEditorScrollDom(), 13); // viewport top = line index 12

  await plugin.syncViewToFile(file);

  assert.strictEqual(view.sections.length, 2, 'sanity: cached cards were loaded into the panel');
  assert.strictEqual(
    view.activeIdx,
    1,
    'opening a note with cached cards must highlight the card at the editor viewport top, with no scroll event',
  );
}

/* ============================================================
 * Round-3 review P1 (main.ts): the post-load synchronization asked the workspace for
 * the ACTIVE Markdown view — but `ensureView()` reveals and FOCUSES the right-side
 * panel first, so by the time the sync runs the active view is our own ItemView and
 * `getActiveViewOfType(MarkdownView)` returns null. The panel loaded its cached cards
 * and highlighted none of them, on the two most common entry points (ribbon/open-view
 * toggle, and a run that hits the cache).
 *
 * These drive the REAL entry points end to end — `toggleParallelView()` and
 * `runForFile()`, both through `ensureView()` — against a workspace that models the
 * focus steal. Calling `syncActiveFromEditor` by hand cannot see this bug at all: the
 * defect is entirely in WHICH editor the caller hands it.
 * ============================================================ */
function makeFocusStealingPanel({ topLineNumber = 13 } = {}) {
  const settings = makeSettings();
  const content = Array.from({ length: 30 }, (_, i) => (i === 2 ? 'Alpha' : i === 12 ? 'Beta' : `filler ${i}`)).join(
    '\n',
  );
  const plugin = makeBasePlugin(settings);
  const view = new t.ParallelReaderView({ view: {} }, plugin);
  view.containerEl = { children: [{}, new FakeEl('div')] };

  const file = makeFakeFile('B.md');
  const mdView = makeFakeEditorMdView(file, makeFakeEditorScrollDom(), topLineNumber);
  const markdownLeaf = { view: mdView };
  const state = { panelOpen: false, panelFocused: false };
  const panelLeaf = {
    view,
    setViewState: async () => {
      state.panelOpen = true;
    },
  };

  plugin.app.workspace.getLeavesOfType = (type) => {
    if (type === 'markdown') return [markdownLeaf];
    return state.panelOpen ? [panelLeaf] : [];
  };
  plugin.app.workspace.getRightLeaf = () => panelLeaf;
  plugin.app.workspace.revealLeaf = async () => {
    state.panelFocused = true;
  };
  // The real `getActiveViewOfType(MarkdownView)` returns null once our own ItemView is
  // the active view — which is precisely what revealing the right-side panel causes.
  plugin.getActiveView = () => (state.panelFocused ? null : mdView);
  plugin.getParallelView = () => (state.panelOpen ? view : undefined);
  plugin.app.vault.read = async () => content;
  plugin.cacheManager.get = () => ({
    schemaVersion: CACHE_SCHEMA_VERSION,
    contentHash: hashContent(content),
    settingsHash: generationFingerprint(settings),
    cards: [
      { title: 'Alpha', anchor: 'Alpha', gist: '', bullets: [] },
      { title: 'Beta', anchor: 'Beta', gist: '', bullets: [] },
    ],
    generatedAt: '2026-01-01T00:00:00.000Z',
  });

  return { plugin, view, file, state };
}

async function testToggleParallelView_CachedCards_HighlightsCardAfterPanelTakesFocus() {
  const { plugin, view, state } = makeFocusStealingPanel();

  await plugin.toggleParallelView();

  assert.strictEqual(state.panelFocused, true, 'sanity: opening the panel reveals (and therefore focuses) it');
  assert.strictEqual(view.sections.length, 2, 'sanity: the cached cards were loaded into the panel');
  assert.strictEqual(
    view.activeIdx,
    1,
    'opening the panel over a note with cached cards must highlight the card the editor is already sitting on — ' +
      'the sync must resolve the editor from the FILE, not from whatever is focused after the panel steals focus',
  );
  assert.ok(view.cards[1].hasClass('is-active'), 'the synchronized card must carry is-active');
}

async function testRunForFile_CacheHit_HighlightsCardAfterPanelTakesFocus() {
  const { plugin, view, file, state } = makeFocusStealingPanel();

  const result = await plugin.runForFile(file, false);

  assert.strictEqual(result, 'cached', 'sanity: the run hit the cache');
  assert.strictEqual(state.panelFocused, true, 'sanity: the run opened (and focused) the panel via ensureView');
  assert.strictEqual(view.sections.length, 2, 'sanity: the cached cards were loaded into the panel');
  assert.strictEqual(
    view.activeIdx,
    1,
    'a run that opens the panel and lands on the cache must still highlight the card at the editor viewport top',
  );
}

/* ============================================================
 * Cross-model review P2 (main.ts:879): getMarkdownViewForFile must prefer the ACTIVE
 * markdown leaf when it shows the target file. `findLeafForFile` returns the FIRST
 * leaf whose view matches by path, in workspace enumeration order — with the same
 * note open in two leaves (a split), that first match need not be the leaf the user
 * is actually looking at, so the initial card sync used to read the wrong viewport
 * and highlight a card for a scroll position the user isn't at.
 *
 * These three tests pin down ONE coherent resolution order: active-if-matching, else
 * first matching leaf — and confirm the round-3 P1 fallback (sidebar focused, no
 * active markdown view at all) still works under the new ordering.
 * ============================================================ */
function testGetMarkdownViewForFile_TwoLeavesSameFile_PrefersActiveLeaf() {
  const plugin = makeBasePlugin(makeSettings());
  const file = makeFakeFile('A.md');

  // Two leaves both show the same file (a split). The first is earlier in workspace
  // enumeration order; the SECOND is the one actually focused.
  const firstLeafMdView = makeFakeEditorMdView(file, makeFakeEditorScrollDom(), 3);
  const secondLeafMdView = makeFakeEditorMdView(file, makeFakeEditorScrollDom(), 25);

  plugin.app.workspace.getLeavesOfType = (type) =>
    type === 'markdown' ? [{ view: firstLeafMdView }, { view: secondLeafMdView }] : [];
  plugin.getActiveView = () => secondLeafMdView;

  const resolved = plugin.getMarkdownViewForFile(file);

  assert.strictEqual(
    resolved,
    secondLeafMdView,
    'with the same file open in two leaves, the ACTIVE leaf must win over the first enumeration match, ' +
      'or the initial sync reads the wrong viewport and highlights the wrong card',
  );
}

function testGetMarkdownViewForFile_ActiveShowsDifferentFile_FallsBackToMatchingLeaf() {
  const plugin = makeBasePlugin(makeSettings());
  const file = makeFakeFile('A.md');
  const otherFile = makeFakeFile('B.md');
  const targetLeafMdView = makeFakeEditorMdView(file, makeFakeEditorScrollDom(), 3);
  const activeMdView = makeFakeEditorMdView(otherFile, makeFakeEditorScrollDom(), 9);

  plugin.app.workspace.getLeavesOfType = (type) => (type === 'markdown' ? [{ view: targetLeafMdView }] : []);
  plugin.getActiveView = () => activeMdView; // focused elsewhere, on a different note

  const resolved = plugin.getMarkdownViewForFile(file);

  assert.strictEqual(
    resolved,
    targetLeafMdView,
    'when the active view shows a DIFFERENT file, resolution must fall back to the leaf actually showing the target file',
  );
}

function testGetMarkdownViewForFile_NoActiveMarkdownView_FallsBackToFirstMatchingLeaf() {
  const plugin = makeBasePlugin(makeSettings());
  const file = makeFakeFile('A.md');
  const mdView = makeFakeEditorMdView(file, makeFakeEditorScrollDom(), 3);

  plugin.app.workspace.getLeavesOfType = (type) => (type === 'markdown' ? [{ view: mdView }] : []);
  // Round-3 P1: the sidebar has focus, so getActiveViewOfType(MarkdownView) returns null.
  plugin.getActiveView = () => null;

  const resolved = plugin.getMarkdownViewForFile(file);

  assert.strictEqual(
    resolved,
    mdView,
    'with no active markdown view at all (sidebar focused), resolution must still fall back to the matching leaf — ' +
      'the round-3 P1 fix must not regress under the new active-first ordering',
  );
}

async function testRefreshViewAfterCacheClear_NoView() {
  const settings = makeSettings();
  const plugin = makeBasePlugin(settings, { view: undefined });
  plugin.getParallelView = () => undefined;

  // Must not throw when no view exists.
  plugin.refreshViewAfterCacheClear();
}

/* ============================================================
 * S3: card highlight — stale on file switch, stolen on click.
 * loadFor(file, sections, stale) must reset activeIdx to -1 (and clear any
 * stale `cards` element references) exactly when the incoming file differs
 * from the one currently shown — never on an ordinary same-file refresh,
 * or scroll-sync position would be lost on every regenerate.
 * ============================================================ */
async function testLoadFor_ResetsActiveIdxOnFileSwitch_PreservesOnSameFile() {
  const plugin = makeBasePlugin(makeSettings());
  const fakeLeaf = { view: {} };
  const view = new t.ParallelReaderView(fakeLeaf, plugin);
  view.render = () => {}; // asserting on state directly; DOM not needed here

  const fileA = makeFakeFile('A.md');
  const fileB = makeFakeFile('B.md');
  const sectionsA = [
    { title: 'a1', anchor: '', gist: '', bullets: [], startLine: 0, level: 0 },
    { title: 'a2', anchor: '', gist: '', bullets: [], startLine: 5, level: 0 },
  ];
  const sectionsB = [{ title: 'b1', anchor: '', gist: '', bullets: [], startLine: 0, level: 0 }];

  view.loadFor(fileA, sectionsA, false);
  view.activeIdx = 1; // simulate scroll-sync having highlighted card #2 of note A
  view.cards = ['stale-card-el-from-note-A']; // simulate leftover DOM refs from note A's render

  view.loadFor(fileB, sectionsB, false);
  assert.strictEqual(view.activeIdx, -1, "switching notes must reset activeIdx (was stuck highlighting note A's card)");
  assert.deepStrictEqual(view.cards, [], 'switching notes must clear stale card element references too');

  // Ordinary refresh/regenerate of the SAME file (e.g. after an edit) must NOT
  // reset activeIdx, or scroll-sync position would be lost on every refresh.
  view.activeIdx = 0;
  view.loadFor(fileB, sectionsB, false);
  assert.strictEqual(view.activeIdx, 0, 'reloading the same file must preserve activeIdx');
}

/* ============================================================
 * S3: clicking a card must own the highlight — both immediately (before the
 * editor even scrolls) and durably (the scroll-sync handler's centered-scroll
 * probe must not steal it back to the preceding card for a short window).
 * ============================================================ */
async function testCardClick_OwnsHighlight_SuppressesStealFromPrecedingCard() {
  const plugin = makeBasePlugin(makeSettings());
  const scrollCalls = [];
  plugin.scrollEditorToLine = async (line, file) => {
    scrollCalls.push([line, file?.path]);
  };

  const fakeLeaf = { view: {} };
  const view = new t.ParallelReaderView(fakeLeaf, plugin);
  const rootEl = new FakeEl('div');
  view.containerEl = { children: [{}, rootEl] };
  plugin.getParallelView = () => view;

  const file = makeFakeFile('A.md');
  const sections = [
    { title: 'c0', anchor: '', gist: '', bullets: [], startLine: 0, level: 0 },
    { title: 'c1', anchor: '', gist: '', bullets: [], startLine: 10, level: 0 },
    { title: 'c2', anchor: '', gist: '', bullets: [], startLine: 20, level: 0 },
  ];
  view.loadFor(file, sections, false); // real render — populates view.cards with FakeEl instances
  assert.strictEqual(view.cards.length, 3, 'sanity check: three cards rendered');

  // Click card #2 (the last card).
  view.cards[2].dispatch('click');

  assert.strictEqual(scrollCalls.length, 1, 'click must trigger exactly one scroll-to-line call');
  assert.deepStrictEqual(scrollCalls[0], [20, 'A.md'], "click scrolls to the clicked card's line");
  assert.strictEqual(
    view.activeIdx,
    2,
    'click must set the CLICKED card active immediately, before the scroll resolves',
  );
  assert.ok(view.cards[2].hasClass('is-active'), 'clicked card must carry is-active synchronously');
  assert.ok(!view.cards[1].hasClass('is-active'), 'preceding card must not be highlighted after the click');
  assert.ok(view.isScrollSyncSuppressed(), 'click must arm the scroll-sync suppression window');

  // Simulate main.ts's handleEditorScroll firing right after — as it would once
  // editor.scrollIntoView's CENTERED landing point resolves near the TOP of the
  // viewport, inside the PRECEDING card's (index 1) line range. This is the
  // exact mechanism that used to steal the highlight back (S3 bug 2).
  const mdView = {
    file,
    editor: {
      cm: {
        scrollDOM: { getBoundingClientRect: () => ({ top: 0, height: 400, left: 0 }) },
        posAtCoords: () => 1,
        state: { doc: { lineAt: () => ({ number: 11 }) } }, // -> topLine 10 -> resolves to card index 1
      },
    },
  };

  plugin.handleEditorScroll(mdView);
  assert.strictEqual(
    view.activeIdx,
    2,
    'while suppressed, scroll-sync must NOT steal the highlight back to the preceding card',
  );

  // Once the suppression window elapses, scroll-sync must resume normally — a
  // timestamp deadline (not a boolean latch) so a scroll event that never
  // arrives cannot wedge sync off forever.
  view.scrollSyncSuppressedUntil = Date.now() - 1;
  assert.ok(!view.isScrollSyncSuppressed(), 'suppression must self-expire once the deadline passes');

  plugin.handleEditorScroll(mdView);
  assert.strictEqual(view.activeIdx, 1, 'after suppression expires, scroll-sync resumes reassigning as normal');
}

/* ============================================================
 * Round-2 review P2 (src/view.ts): the click-suppression deadline is a property of ONE
 * note's click, but it used to survive a file switch. Opening note B within 400ms of
 * clicking a card in note A left B inheriting A's suppression window, so the first
 * syncActiveFromEditor pass for B returned early and B stayed unhighlighted until the
 * user physically scrolled — precisely the bug the S3 fix exists to prevent, arriving
 * through a different door.
 * ============================================================ */
async function testClickSuppression_DoesNotLeakAcrossAFileSwitch() {
  const plugin = makeBasePlugin(makeSettings());
  plugin.scrollEditorToLine = async () => {};

  const view = new t.ParallelReaderView({ view: {} }, plugin);
  view.containerEl = { children: [{}, new FakeEl('div')] };
  plugin.getParallelView = () => view;

  const fileA = makeFakeFile('A.md');
  const sectionsA = [
    { title: 'a0', anchor: '', gist: '', bullets: [], startLine: 0, level: 0 },
    { title: 'a1', anchor: '', gist: '', bullets: [], startLine: 10, level: 0 },
  ];
  view.loadFor(fileA, sectionsA, false);
  view.cards[1].dispatch('click');
  assert.ok(view.isScrollSyncSuppressed(), 'sanity: clicking a card arms the suppression window');

  // A refresh of the SAME note (a regenerate landing mid-window, say) must keep the
  // suppression — it exists to survive exactly the renders that follow a click.
  view.loadFor(fileA, sectionsA, false);
  assert.ok(view.isScrollSyncSuppressed(), 'a same-file refresh must not disarm the click suppression');

  // Switching notes inside the 400ms window: B must start with a clean slate.
  const fileB = makeFakeFile('B.md');
  const sectionsB = [
    { title: 'b0', anchor: '', gist: '', bullets: [], startLine: 0, level: 0 },
    { title: 'b1', anchor: '', gist: '', bullets: [], startLine: 10, level: 0 },
  ];
  view.loadFor(fileB, sectionsB, false);
  assert.ok(
    !view.isScrollSyncSuppressed(),
    "opening a different note must clear the suppression armed by a click in the PREVIOUS note — the deadline belongs to that note's click, not to the panel",
  );

  // The consequence that actually reaches the user: the first sync for B must land.
  const mdViewB = {
    file: fileB,
    editor: {
      cm: {
        scrollDOM: { getBoundingClientRect: () => ({ top: 0, height: 400, left: 0 }) },
        posAtCoords: () => 1,
        state: { doc: { lineAt: () => ({ number: 11 }) } }, // -> topLine 10 -> card index 1
      },
    },
  };
  plugin.syncActiveFromEditor(mdViewB);
  assert.strictEqual(
    view.activeIdx,
    1,
    'the newly opened note must be highlighted immediately, not left blank until the user scrolls',
  );
}

/* ============================================================
 * S6: stale banner — no longer relies on colour alone (icon cue), and its
 * regenerate action must survive the contrast/markup rework untouched.
 * ============================================================ */
async function testRenderStaleBanner_HasIconCueAndRegenerateAction() {
  const plugin = makeBasePlugin(makeSettings());
  let regenerateCalls = null;
  plugin.runForFile = async (file, force) => {
    regenerateCalls = [file?.path, force];
    return 'ok';
  };

  const fakeLeaf = { view: {} };
  const view = new t.ParallelReaderView(fakeLeaf, plugin);
  const rootEl = new FakeEl('div');
  view.containerEl = { children: [{}, rootEl] };

  const file = makeFakeFile('A.md');
  const sections = [{ title: 'a1', anchor: '', gist: '', bullets: [], startLine: 0, level: 0 }];
  view.loadFor(file, sections, true); // stale=true — must render the banner

  const banner = rootEl.children.find((c) => c.hasClass('parallel-reader-stale-banner'));
  assert.ok(banner, 'stale banner must render when view.stale is true');

  const icon = banner.children.find((c) => c.hasClass('parallel-reader-stale-icon'));
  assert.ok(icon, 'banner must carry a non-colour (icon) cue so state is not conveyed by colour alone');

  const text = banner.children.find((c) => c.hasClass('parallel-reader-stale-text'));
  assert.ok(text?.textContent, 'banner must still show the stale message text');

  const button = banner.children.find((c) => c.hasClass('parallel-reader-stale-button'));
  assert.ok(button, 'banner must still expose the regenerate action');

  button.dispatch('click');
  assert.deepStrictEqual(
    regenerateCalls,
    ['A.md', true],
    'clicking the banner action must still trigger a forced regenerate',
  );
}

/* ============================================================
 * S7: doubled tooltip -- addIconButton used to set the native `title`
 * attribute on top of Obsidian's own aria-label-driven tooltip, so hovering
 * an icon button showed Obsidian's tooltip and then the OS tooltip a moment
 * later. It must now route through Obsidian's setTooltip() exclusively.
 * ============================================================ */
function testAddIconButton_UsesObsidianTooltip_NotNativeTitle() {
  takeTooltips(); // drain setTooltip calls accumulated by earlier tests' renders in this file
  const parent = new FakeEl('div');
  t.addIconButton(
    parent,
    'refresh-cw',
    'Regenerate',
    () => {},
    (key) => key,
  );

  const button = parent.children[0];
  assert.strictEqual(
    button.title,
    undefined,
    "native title attribute must stay unset -- it used to double Obsidian's own tooltip",
  );

  const tooltips = takeTooltips();
  assert.strictEqual(tooltips.length, 1, 'addIconButton must call setTooltip exactly once');
  assert.strictEqual(tooltips[0].el, button, 'setTooltip must target the created button element');
  assert.strictEqual(tooltips[0].tooltip, 'Regenerate', 'tooltip text must match the requested title');
  assert.strictEqual(tooltips[0].options?.placement, 'bottom', 'tooltip should be placed below the button');
}

/* ============================================================
 * S7: `Element.scrollIntoView`'s explicit `behavior: 'smooth'` overrides the
 * CSS `scroll-behavior` property, so a media query in styles.css alone cannot
 * honor `prefers-reduced-motion` for the scroll-sync jump -- the JS call site
 * must check it directly (see ParallelReaderView.scrollSyncBehavior).
 * ============================================================ */
function testSetActiveSection_ScrollBehavior_RespectsReducedMotion() {
  const plugin = makeBasePlugin(makeSettings());
  const fakeLeaf = { view: {} };
  const view = new t.ParallelReaderView(fakeLeaf, plugin);
  const rootEl = new FakeEl('div');
  view.containerEl = { children: [{}, rootEl] };

  const file = makeFakeFile('A.md');
  const sections = [
    { title: 'a', anchor: '', gist: '', bullets: [], startLine: 0, level: 0 },
    { title: 'b', anchor: '', gist: '', bullets: [], startLine: 1, level: 0 },
  ];
  view.loadFor(file, sections, false);

  const hadMatchMedia = Object.hasOwn(globalThis, 'matchMedia');
  const originalMatchMedia = globalThis.matchMedia;
  try {
    delete globalThis.matchMedia;
    view.setActiveSection(0);
    assert.strictEqual(
      view.cards[0].lastScrollIntoView?.behavior,
      'smooth',
      'without a matchMedia API available, scroll-sync must default to smooth',
    );

    globalThis.matchMedia = (query) => ({ matches: true, media: query });
    view.setActiveSection(1);
    assert.strictEqual(
      view.cards[1].lastScrollIntoView?.behavior,
      'auto',
      'prefers-reduced-motion: reduce must switch scroll-sync to an instant (non-smooth) scroll',
    );

    globalThis.matchMedia = (query) => ({ matches: false, media: query });
    view.setActiveSection(0);
    assert.strictEqual(
      view.cards[0].lastScrollIntoView?.behavior,
      'smooth',
      'without a reduced-motion preference, scroll-sync must stay smooth',
    );
  } finally {
    if (hadMatchMedia) globalThis.matchMedia = originalMatchMedia;
    else delete globalThis.matchMedia;
  }
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
  testGetMarkdownViewForFile_TwoLeavesSameFile_PrefersActiveLeaf();
  testGetMarkdownViewForFile_ActiveShowsDifferentFile_FallsBackToMatchingLeaf();
  testGetMarkdownViewForFile_NoActiveMarkdownView_FallsBackToFirstMatchingLeaf();
  await testRefreshViewAfterCacheDelete_MatchingFile();
  await testRefreshViewAfterCacheDelete_DifferentFile();
  await testRefreshViewAfterCacheClear_AlwaysClears();
  await testCacheClear_RefreshesView_LikeClearAllCommand();
  await testCacheClear_NoView_DoesNotThrow();
  await testRefreshViewAfterCacheClear_NoView();
  await testRunForFile_AlreadyRunning_EarlyReturn();
  await testRunForFile_AlreadyRunning_FromCatch();
  await testRunForFile_Cancelled_FromCatch();
  await testRunForFile_GenericError_FromCatch();
  await testRunForFile_RegenerateConfirm_Cancels();
  await testRunForFile_SkipEditConfirm_BypassesPrompt();
  await testViewDeleteCard_PersistFails_ReturnsFalse();
  await testViewDeleteCard_PersistThrows_RollsBack();
  await testViewDeleteCard_PersistOk_ReturnsTrue();
  await testViewUpdateCard_PersistFails_ReturnsFalse();
  await testViewUpdateCard_PersistThrows_RollsBack();
  await testViewDeleteCard_FileSwitchedMidWrite_DoesNotRepaintNewNote();
  await testViewUpdateCard_FileSwitchedMidWrite_DoesNotRepaintNewNote();
  await testConcurrentDeletes_BothApply_NeitherIsOverwritten();
  await testConcurrentUpdateAndDelete_BothApply();
  await testConcurrentDeletes_FileSwitchesMidQueue_SecondInheritsTheFirstsResult();
  await testConcurrentDeletes_SecondWriteFails_RollsBackOnlyItself();
  await testViewDeleteCard_SupersededBySameCardMutation_ShowsNoticeAndReturnsFalse();
  await testViewUpdateCard_SupersededBySameCardMutation_ShowsNoticeAndReturnsFalse();
  await testInterleavedMutations_ABA_SecondANoteMutationDoesNotResurrectADeletedCard();
  await testInterleavedMutations_ABA_ReResolvedCardsAbortRatherThanResurrect();
  testBindScrollSync_SyncsActiveCardWithoutAnyScrollEvent();
  await testSyncViewToFile_SyncsActiveCardWithoutAnyScrollEvent();
  await testToggleParallelView_CachedCards_HighlightsCardAfterPanelTakesFocus();
  await testRunForFile_CacheHit_HighlightsCardAfterPanelTakesFocus();
  await testLoadFor_ResetsActiveIdxOnFileSwitch_PreservesOnSameFile();
  await testCardClick_OwnsHighlight_SuppressesStealFromPrecedingCard();
  await testClickSuppression_DoesNotLeakAcrossAFileSwitch();
  await testRenderStaleBanner_HasIconCueAndRegenerateAction();
  testAddIconButton_UsesObsidianTooltip_NotNativeTitle();
  testSetActiveSection_ScrollBehavior_RespectsReducedMotion();
  console.log('view-render tests passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
