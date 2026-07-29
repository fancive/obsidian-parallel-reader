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

/**
 * Extract a class method's `async` flag and brace-matched body text from `source`.
 * Used by the onOpen guard below, which must distinguish "async with no await inside"
 * (a gratuitous async that should just return a Promise instead, as onOpen does today)
 * from "async that legitimately awaits something" (fine — ItemView.onOpen() returns
 * Promise<void>, so a future implementation may need to await real work). A fixed-width
 * regex window can't express that distinction reliably, so this does a small brace scan.
 */
function findMethodBody(source, methodName) {
  const signature = new RegExp(`(async\\s+)?\\b${methodName}\\s*\\([^)]*\\)\\s*\\{`);
  const match = signature.exec(source);
  if (!match) return null;
  const braceStart = match.index + match[0].length - 1;
  let depth = 1;
  let i = braceStart + 1;
  while (i < source.length && depth > 0) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
    i++;
  }
  return { isAsync: !!match[1], body: source.slice(braceStart + 1, i - 1) };
}

// View lifecycle guards
const onOpenMethod = findMethodBody(viewSource, 'onOpen');
assert.ok(onOpenMethod, 'ParallelReaderView.onOpen should exist');
assert.ok(
  !(onOpenMethod.isAsync && !/\bawait\b/.test(onOpenMethod.body)),
  'ParallelReaderView.onOpen should not be async without an await in its body',
);
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
assert.ok(/handleFileRename[\s\S]*cacheManager\.move/.test(mainSource), 'file rename should delegate cache moves');
// The invariant these two guards claimed to enforce — that touching the cache debounces
// its write instead of writing synchronously — is now asserted behaviorally in
// tests/direct-cache.test.js (N touches -> exactly one adapter write, under a fake clock)
// instead of as source-text regexes. Both prior regexes matched zero times against any
// version of main.ts: `this.saveCache` and `cacheManager.cache[` do not occur there — main.ts
// delegates entirely to CacheManager (see cacheTouch/handleFileRename above), which owns the
// debounce and the cache map. A regex that can never match enforces nothing.

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
assert.ok(
  /hide\(\)[\s\S]{0,300}super\.hide\(\)/.test(settingsTabSource),
  "settings tab hide() should chain up to super.hide() so SettingTab's component cleanup still runs",
);

// Non-colour state cue (S7 / review P2): the active card's title must carry a structural
// cue, not just a different hue -- colour alone is invisible in monochrome/high-contrast
// themes and to users who cannot distinguish the accent from --text-normal.
const activeTitleRule = /\.parallel-reader-card\.is-active\s+\.parallel-reader-card-title\s*\{([^}]*)\}/.exec(
  fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8'),
);
assert.ok(activeTitleRule, 'styles.css should style the active card title');
assert.ok(
  /text-decoration|font-weight|border-|text-underline|::before/.test(activeTitleRule[1]),
  'the active card title must carry a non-colour cue (underline/weight/marker), not colour alone',
);

console.log('architecture tests passed');
