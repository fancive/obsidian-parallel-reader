/**
 * Architecture guard tests — verify source code structure invariants
 * that cannot be expressed via TypeScript types or lint rules.
 */
const fs = require('fs');
const path = require('path');
const { assert } = require('./test-setup');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.ts'), 'utf8');
const viewSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'view.ts'), 'utf8');
const settingsTabSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'settings-tab.ts'), 'utf8');

// View lifecycle guards
assert.ok(!/\basync\s+onOpen\s*\(/.test(viewSource), 'ParallelReaderView.onOpen should not be async without await');
assert.ok(!/\basync\s+onClose\s*\(\)\s*\{\s*\}/.test(viewSource), 'empty onClose should not be async');
assert.ok(/focusSummaryPane\s*\(\)/.test(viewSource), 'summary pane should expose a focus helper');
assert.ok(
  /\.focus\(\{\s*preventScroll:\s*true\s*\}\)/.test(viewSource),
  'summary pane focus should not scroll the page',
);
assert.ok(/moveActiveSection[\s\S]*focusSummaryPane/.test(viewSource), 'card navigation should focus the summary pane');

// Cache debounce guards
assert.ok(/scheduleCacheSave\s*\(/.test(mainSource), 'cache touch should use a debounced cache save path');
assert.ok(/flushCacheSave\s*\(/.test(mainSource), 'pending cache touches should be flushable');
assert.ok(/onunload[\s\S]*flushCacheSave/.test(mainSource), 'plugin unload should flush pending cache touches');
assert.ok(/cacheTouch[\s\S]*scheduleCacheSave/.test(mainSource), 'cacheTouch should schedule a cache save');
assert.ok(
  !/cacheTouch[\s\S]{0,220}await this\.saveCache/.test(mainSource),
  'cacheTouch should not synchronously write cache.json',
);
assert.ok(/handleFileRename[\s\S]*cacheManager\.move/.test(mainSource), 'file rename should delegate cache moves');
assert.ok(
  !/handleFileRename[\s\S]*cacheManager\.cache\[/.test(mainSource),
  'file rename should not mutate cache directly',
);

// Module extraction guards
assert.ok(!/function addIconButton/.test(mainSource), 'UI icon helper should live outside main.ts');
assert.ok(!/function addTextButton/.test(mainSource), 'UI text-button helper should live outside main.ts');
assert.ok(!/function copyToClipboard/.test(mainSource), 'clipboard helper should live outside main.ts');

// Lifecycle guards (S9): the editor scroll listener must be owned by a child Component
// (so a rebind can detach only its own listener, and unloading the plugin detaches it
// automatically through Obsidian's Component unload cascade) instead of a raw
// addEventListener + hand-rolled dispose closure that onunload() could forget to call.
assert.ok(
  !/_scrollDispose/.test(mainSource),
  'scroll listener should not use a bare dispose closure (onunload could forget to call it)',
);
assert.ok(
  /registerDomEvent\(scrollDom/.test(mainSource),
  'editor scroll listener should be owned via Component#registerDomEvent, not a raw addEventListener call',
);
assert.ok(
  /removeChild\(this\._scrollSync\)/.test(mainSource),
  'bindScrollSync should remove the previous scroll-sync child component before creating a new one',
);

// Lifecycle guards (S9): debounced settings/cache writes must have a path that Obsidian
// actually waits on before quitting. onunload() cannot be awaited, so a `workspace.on('quit', ...)`
// handler using the Tasks mechanism (`tasks.addPromise`) is required for that guarantee.
assert.ok(
  /workspace\.on\(\s*'quit'/.test(mainSource),
  "plugin should register a workspace 'quit' handler to flush pending debounced writes",
);
assert.ok(
  /workspace\.on\(\s*'quit'[\s\S]{0,400}tasks\.addPromise/.test(mainSource),
  "the 'quit' handler should flush via tasks.addPromise(...), the mechanism Obsidian actually awaits before exiting",
);

// The settings tab must flush a pending debounced settings write when closed, instead of
// racing its 400ms debounce against the user quitting or the vault unloading.
assert.ok(
  /hide\(\)[\s\S]{0,200}flushSettingsSave/.test(settingsTabSource),
  'settings tab should override hide() to flush pending debounced settings writes',
);

console.log('architecture tests passed');
