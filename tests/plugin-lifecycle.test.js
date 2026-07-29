/**
 * Regression coverage for S9 (docs/scope-ship-now-batch.md): the editor scroll-listener
 * leak and settings/cache loss on quit.
 *
 * bindScrollSync() now owns the scroll listener through a dedicated child `Component`
 * (registered via `addChild`/`registerDomEvent`) instead of a raw `addEventListener` +
 * hand-rolled dispose closure. These tests exercise the REAL Component semantics from
 * tests/obsidian-mock.mjs (addChild/removeChild/registerDomEvent, and the unload cascade)
 * rather than stubbing them away, since the whole point of the fix is that a rebind or a
 * plugin unload must not leave a listener (and the plugin instance it closes over)
 * attached to the CodeMirror scroller.
 */
const { assert, t } = require('./test-setup');

/** Minimal fake CodeMirror scrollDOM: just enough addEventListener/removeEventListener
 * bookkeeping to assert on listener counts, matching how the real DOM node behaves. */
function makeFakeScrollDom() {
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
    count(type = 'scroll') {
      return listeners.filter((l) => l.type === type).length;
    },
  };
}

function makeFakeMdView(scrollDom) {
  return {
    editor: {
      cm: {
        scrollDOM: scrollDom,
        state: { doc: { lineAt: () => ({ number: 1 }) } },
        posAtCoords: () => null,
      },
    },
    contentEl: { querySelector: () => null },
    file: { path: 'note.md' },
  };
}

function testBindScrollSync_RebindDoesNotAccumulateListeners() {
  const plugin = new t.ParallelReaderPlugin();
  const scrollDom = makeFakeScrollDom();
  plugin.getActiveView = () => makeFakeMdView(scrollDom);

  // In the real running plugin, Obsidian's Component.load() marks the plugin loaded
  // BEFORE invoking onload() (which is what calls bindScrollSync() the first time), so
  // by the time any bindScrollSync() call runs, `addChild` always loads the new child
  // component immediately (and `removeChild` always actually unloads the old one).
  // Skip the real (heavy, full-app-dependent) onload() body but still flip the plugin
  // into that same loaded state via the real Component.load() lifecycle mock.
  plugin.onload = () => {};
  plugin.load();

  // `active-leaf-change` fires bindScrollSync() again every time the user switches
  // panes/tabs, without the plugin ever unloading in between.
  plugin.bindScrollSync();
  plugin.bindScrollSync();
  plugin.bindScrollSync();

  assert.strictEqual(
    scrollDom.count(),
    1,
    'rebinding across repeated active-leaf-change events must not accumulate scroll listeners',
  );
}

function testBindScrollSync_PluginUnload_DetachesListener() {
  const plugin = new t.ParallelReaderPlugin();
  const scrollDom = makeFakeScrollDom();
  plugin.getActiveView = () => makeFakeMdView(scrollDom);
  // onunload() also flushes the cache; keep it a harmless no-op for this test so we're
  // only asserting on the scroll-listener cascade, not cache-flush plumbing.
  plugin.cacheManager = { flush: async () => {} };

  // Skip the real (heavy, full-app-dependent) onload() body but still exercise the real
  // Component.load()/unload() lifecycle mock, so addChild/removeChild behave exactly as
  // they do for the actual running plugin.
  plugin.onload = () => {};
  plugin.load();

  plugin.bindScrollSync();
  assert.strictEqual(scrollDom.count(), 1, 'binding once attaches exactly one scroll listener');

  plugin.unload();
  assert.strictEqual(
    scrollDom.count(),
    0,
    'unloading the plugin must detach the scroll listener via the Component unload cascade, ' +
      'so the dead plugin instance it closes over is no longer reachable from the live scroller',
  );
}

function testSettingsTabHide_FlushesPendingSettingsWrite() {
  let flushed = false;
  const fakePlugin = {
    flushSettingsSave: async () => {
      flushed = true;
    },
  };
  const tab = new t.ParallelReaderSettingTab({}, fakePlugin);

  tab.hide();

  assert.strictEqual(
    flushed,
    true,
    'closing the settings tab must flush any pending debounced settings write immediately',
  );
}

async function testSettingsTabHide_FlushRejection_DoesNotThrow() {
  const fakePlugin = {
    flushSettingsSave: async () => {
      throw new Error('disk full');
    },
  };
  const tab = new t.ParallelReaderSettingTab({}, fakePlugin);
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    assert.doesNotThrow(() => tab.hide(), 'hide() must not throw synchronously even if the flush rejects');
    // hide() fires the flush-and-catch as a floating promise; let it settle (and get
    // swallowed by the stubbed console.error above) before restoring console.error, so
    // this test doesn't leak an unhandled-looking stack trace into later test output.
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    console.error = originalConsoleError;
  }
}

(async () => {
  testBindScrollSync_RebindDoesNotAccumulateListeners();
  testBindScrollSync_PluginUnload_DetachesListener();
  testSettingsTabHide_FlushesPendingSettingsWrite();
  await testSettingsTabHide_FlushRejection_DoesNotThrow();
  console.log('plugin-lifecycle tests passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
