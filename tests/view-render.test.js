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
 * mock in obsidian-mock.js only stubs `containerEl.children` as plain `{}`
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
  scrollIntoView() {}
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
  await testLoadFor_ResetsActiveIdxOnFileSwitch_PreservesOnSameFile();
  await testCardClick_OwnsHighlight_SuppressesStealFromPrecedingCard();
  await testRenderStaleBanner_HasIconCueAndRegenerateAction();
  console.log('view-render tests passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
