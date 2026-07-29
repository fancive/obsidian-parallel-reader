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

/** The real plugin always has `app`; bindScrollSync's initial editor→card sync reads
 * `app.workspace` through getParallelView(). No panel is open in these tests. */
function stubApp(plugin) {
  plugin.app = { workspace: { getLeavesOfType: () => [] } };
  return plugin;
}

function testBindScrollSync_RebindDoesNotAccumulateListeners() {
  const plugin = stubApp(new t.ParallelReaderPlugin());
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
  const plugin = stubApp(new t.ParallelReaderPlugin());
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

/**
 * Review P1 (main.ts): the debounce callback clears `_settingsSaveTimer` BEFORE the
 * async `saveSettings()` settles. `flushSettingsSave()` only looked at that timer, so a
 * quit landing inside the window between "timer fired" and "saveData() resolved" awaited
 * nothing at all: `workspace.on('quit')`'s Tasks promise resolved immediately and the
 * process could exit with the setting still unwritten. The flush must await the write
 * that is actually in flight, not just a pending timer.
 */
async function testFlushSettingsSave_AwaitsWriteAlreadyInFlight() {
  const plugin = new t.ParallelReaderPlugin();
  plugin.settings = { uiLanguage: 'en' };
  let saveDataCalls = 0;
  let saveDataSettled = false;
  let resolveSaveData = null;
  plugin.saveData = () => {
    saveDataCalls++;
    return new Promise((resolve) => {
      resolveSaveData = () => {
        saveDataSettled = true;
        resolve();
      };
    });
  };

  plugin.saveSettingsDebounced(1);
  await new Promise((resolve) => setTimeout(resolve, 10)); // let the debounce timer fire

  assert.strictEqual(saveDataCalls, 1, 'sanity: the debounce timer fired and started the write');
  assert.strictEqual(plugin._settingsSaveTimer, null, 'sanity: the timer is cleared before the write settles');
  assert.strictEqual(saveDataSettled, false, 'sanity: the write is still in flight');

  let flushResolved = false;
  const flush = plugin.flushSettingsSave().then(() => {
    flushResolved = true;
  });
  // Give the flush every chance to resolve on its own (microtasks + a macrotask turn).
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.strictEqual(
    flushResolved,
    false,
    'flushSettingsSave() must not resolve while the debounced saveData() it exists to guarantee is still pending — quit would exit with the setting lost',
  );

  resolveSaveData();
  await flush;
  assert.strictEqual(flushResolved, true, 'the flush resolves once the in-flight write lands');
  assert.strictEqual(saveDataSettled, true, 'the awaited write actually completed');
  assert.strictEqual(saveDataCalls, 1, 'flushing an in-flight save must await it, not start a second write');
}

/**
 * Round-2 review P1 (main.ts): tracking the pending write in a SINGLE slot does not make
 * settings writes ordered. A second save overwrote the slot, so two writes could be in
 * flight at once and land in either order — and `flushSettingsSave()` awaited only the
 * newest one, so quit could resolve while an OLDER write was still pending and then
 * overwrite the newer settings on disk.
 *
 * The fix is to serialize settings writes on a queue and make flush await the queue TAIL.
 *
 * The harness below models a disk that commits the payload at COMPLETION time (not at
 * call time) and lets the test settle writes newest-first — the pathological ordering a
 * real filesystem is free to produce.
 */
function makeOrderedSettingsPlugin() {
  const plugin = new t.ParallelReaderPlugin();
  plugin.settings = { uiLanguage: 'en' };
  const state = { calls: [], pending: [], disk: null };
  plugin.saveData = (data) => {
    const payload = data.settings.uiLanguage;
    state.calls.push(payload);
    return new Promise((resolve) => {
      state.pending.push(() => {
        state.disk = payload;
        resolve();
      });
    });
  };
  return { plugin, state };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function testOverlappingSettingsSaves_NewestSettingsWinOnDisk() {
  const { plugin, state } = makeOrderedSettingsPlugin();

  const older = plugin.saveSettings(); // writes uiLanguage: 'en'
  plugin.settings = { uiLanguage: 'fr' };
  const newer = plugin.saveSettings(); // writes uiLanguage: 'fr'
  await tick();

  // Settle newest-first, so an unordered implementation lands the stale payload last.
  while (state.pending.length) {
    state.pending.pop()();
    await tick();
  }
  await Promise.all([older, newer]);

  assert.strictEqual(
    state.disk,
    'fr',
    'the newest settings must be the last thing written to disk — an older write completing after a newer one silently reverts the user’s change',
  );
}

async function testFlushSettingsSave_AwaitsEveryQueuedWrite_NotJustTheNewest() {
  const { plugin, state } = makeOrderedSettingsPlugin();

  const older = plugin.saveSettings();
  plugin.settings = { uiLanguage: 'fr' };
  const newer = plugin.saveSettings();
  await tick();

  let flushResolved = false;
  const flush = plugin.flushSettingsSave().then(() => {
    flushResolved = true;
  });
  await tick();
  assert.strictEqual(flushResolved, false, 'sanity: flush cannot resolve before any write has landed');

  // Settle the most recent write, leaving an older one outstanding.
  state.pending.pop()();
  await tick();
  assert.strictEqual(
    flushResolved,
    false,
    'flushSettingsSave() must not resolve while any settings write is still pending — quit would exit and let that older write overwrite the newer settings',
  );

  while (state.pending.length) {
    state.pending.pop()();
    await tick();
  }
  await Promise.all([older, newer, flush]);

  assert.strictEqual(flushResolved, true, 'the flush resolves once every queued settings write has landed');
  assert.strictEqual(state.disk, 'fr', 'and the newest settings are what remain on disk');
}

async function testFlushSettingsSave_NoPendingWork_IsANoop() {
  const plugin = new t.ParallelReaderPlugin();
  plugin.settings = { uiLanguage: 'en' };
  let saveDataCalls = 0;
  plugin.saveData = async () => {
    saveDataCalls++;
  };

  await plugin.flushSettingsSave();

  assert.strictEqual(saveDataCalls, 0, 'flushing with no pending timer and no in-flight write must not write');
}

/**
 * Review P2 (src/settings-tab.ts): the `hide()` override skipped `super.hide()`, so
 * SettingTab's documented component cleanup never ran. The lifecycle mock used to declare
 * `class PluginSettingTab {}` with no members, which made the omission undetectable — the
 * mock now implements the documented base `hide()` so this test can see it.
 */
function testSettingsTabHide_CallsBaseCleanup() {
  const fakePlugin = { flushSettingsSave: async () => {} };
  const tab = new t.ParallelReaderSettingTab({}, fakePlugin);

  tab.hide();

  assert.strictEqual(
    tab.baseHideCalls,
    1,
    "hide() must call super.hide() so SettingTab's documented component cleanup still runs",
  );
}

(async () => {
  testBindScrollSync_RebindDoesNotAccumulateListeners();
  testBindScrollSync_PluginUnload_DetachesListener();
  testSettingsTabHide_FlushesPendingSettingsWrite();
  await testSettingsTabHide_FlushRejection_DoesNotThrow();
  await testFlushSettingsSave_AwaitsWriteAlreadyInFlight();
  await testOverlappingSettingsSaves_NewestSettingsWinOnDisk();
  await testFlushSettingsSave_AwaitsEveryQueuedWrite_NotJustTheNewest();
  await testFlushSettingsSave_NoPendingWork_IsANoop();
  testSettingsTabHide_CallsBaseCleanup();
  console.log('plugin-lifecycle tests passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
