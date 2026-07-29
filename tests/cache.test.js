const { assert, t } = require('./test-setup');

// ── touchCacheEntry / serializeCacheFile / shouldConfirmRegenerate ──

assert.strictEqual(t.touchCacheEntry(null), null, 'touchCacheEntry on null returns null');
const entry = { generatedAt: '2024-01-01T00:00:00.000Z' };
const touched = t.touchCacheEntry(entry, '2024-06-01T00:00:00.000Z');
assert.strictEqual(
  touched.lastAccessedAt,
  '2024-06-01T00:00:00.000Z',
  'touchCacheEntry sets lastAccessedAt on returned entry',
);
assert.strictEqual(entry.lastAccessedAt, undefined, 'touchCacheEntry does not mutate original entry');

const serialized = t.serializeCacheFile({ 'a.md': { cards: [] } });
const parsed = JSON.parse(serialized);
assert.strictEqual(parsed.version, 1, 'cache file has version 1');
assert.ok(parsed.entries['a.md'], 'cache file has entries');
assert.strictEqual(serialized.includes('\n'), false, 'cache file is single line');

assert.strictEqual(t.shouldConfirmRegenerate(null, true), false, 'null entry never confirms');
assert.strictEqual(t.shouldConfirmRegenerate(null, false), false);
assert.strictEqual(t.shouldConfirmRegenerate({ generatedAt: '2024-01-01' }, true), false, 'no updatedAt => no confirm');
assert.strictEqual(t.shouldConfirmRegenerate({ updatedAt: '2024-01-01' }, false), false, 'force=false => no confirm');
assert.strictEqual(t.shouldConfirmRegenerate({ updatedAt: '2024-01-01' }, true), true, 'edited + force => confirm');
assert.strictEqual(t.shouldConfirmRegenerate({ updatedAt: '  ' }, true), false, 'whitespace updatedAt => no confirm');

// ── CacheManager.move ──

async function testCacheManagerMove() {
  const writes = [];
  const adapter = {
    exists: async () => true,
    mkdir: async () => {},
    read: async () => '{}',
    write: async (filePath, content) => writes.push({ filePath, content }),
  };
  const manager = new t.CacheManager(adapter, '.obsidian', 'parallel-reader', () => ({
    maxCacheEntries: 100,
  }));
  const cacheEntry = { generatedAt: '2024-01-01T00:00:00.000Z', cards: [{ title: 'Card' }] };
  manager.cache = {
    'old.md': cacheEntry,
    'other.md': { generatedAt: '2024-01-02T00:00:00.000Z', cards: [] },
  };

  assert.strictEqual(await manager.move('missing.md', 'new.md'), false, 'missing cache move returns false');
  assert.strictEqual(await manager.move('missing.md', 'missing.md'), false, 'missing same-path move returns false');
  assert.strictEqual(await manager.move('  ', 'new.md'), false, 'blank source path is rejected');
  assert.strictEqual(await manager.move('old.md', '   '), false, 'blank target path is rejected');
  assert.strictEqual(await manager.move('old.md', 'old.md'), true, 'same-path move is a no-op success');
  assert.strictEqual(
    await manager.move('old.md', 'other.md'),
    false,
    'move does not overwrite an existing target path',
  );
  assert.strictEqual(writes.length, 0, 'no-op and rejected cache moves are not persisted');
  assert.strictEqual(await manager.move('old.md', 'new.md'), true, 'existing cache move returns true');
  assert.strictEqual(manager.cache['old.md'], undefined, 'old cache path is removed');
  assert.deepStrictEqual(manager.cache['new.md'], cacheEntry, 'cache entry is moved to new path');
  assert.ok(manager.cache['other.md'], 'unrelated cache entries remain');
  assert.strictEqual(writes.length, 1, 'successful cache move is persisted once');
  assert.ok(JSON.parse(writes[0].content).entries['new.md'], 'persisted cache uses moved path');
}

// ── CacheManager: a rejected adapter write must not leave the edit in memory ──
// Review P1 (src/cache-manager.ts): every mutator wrote `this.cache` BEFORE awaiting
// save(). When the adapter write rejected, the view correctly reported failure but the
// in-memory cache kept the edit, so reopening the note silently applied the change the
// UI had just called failed — and the next successful write (a debounced touch, say)
// flushed it to disk. Memory must never diverge from what the write actually committed.

function makeRejectingAdapter(message = 'disk full') {
  return {
    exists: async () => true,
    mkdir: async () => {},
    read: async () => '{}',
    write: async () => {
      throw new Error(message);
    },
  };
}

function makeManager(adapter) {
  return new t.CacheManager(adapter, '.obsidian', 'parallel-reader', () => ({ maxCacheEntries: 100 }));
}

function makeEntry(title) {
  return {
    schemaVersion: t.CACHE_SCHEMA_VERSION,
    contentHash: 'content-hash',
    settingsHash: 'settings-hash',
    cards: [{ title, anchor: '', gist: '', bullets: [] }],
    generatedAt: '2024-01-01T00:00:00.000Z',
  };
}

async function testReplaceCardsRestoresEntryWhenWriteRejects() {
  const manager = makeManager(makeRejectingAdapter());
  const original = makeEntry('old');
  manager.cache = { 'a.md': original };

  await assert.rejects(
    () => manager.replaceCards('a.md', [{ title: 'new', anchor: '', gist: '', bullets: [] }]),
    /disk full/,
    'a rejected adapter write must surface as a rejection',
  );

  assert.strictEqual(
    manager.cache['a.md'].cards[0].title,
    'old',
    'a rejected write must not leave the edit in the in-memory cache — reopening the note would apply a change the UI reported as failed',
  );
  assert.deepStrictEqual(manager.cache['a.md'], original, 'the previous cache entry must be restored verbatim');
}

async function testPutRestoresEntryWhenWriteRejects() {
  const manager = makeManager(makeRejectingAdapter());
  const original = makeEntry('old');
  manager.cache = { 'a.md': original };

  await assert.rejects(
    () => manager.put('a.md', 'new content', [{ title: 'new', anchor: '', gist: '', bullets: [] }], { maxCards: 5 }),
    /disk full/,
    'put must surface a rejected adapter write',
  );

  assert.deepStrictEqual(manager.cache['a.md'], original, 'a rejected put must not leave the new entry in memory');
}

async function testDeleteRestoresEntryWhenWriteRejects() {
  const manager = makeManager(makeRejectingAdapter());
  const original = makeEntry('old');
  manager.cache = { 'a.md': original };

  await assert.rejects(() => manager.delete('a.md'), /disk full/, 'delete must surface a rejected adapter write');

  assert.deepStrictEqual(
    manager.cache['a.md'],
    original,
    'a rejected delete must not remove the entry from memory — the entry is still on disk',
  );
}

async function testMoveAndClearRestoreCacheWhenWriteRejects() {
  const moveManager = makeManager(makeRejectingAdapter());
  const moved = makeEntry('moved');
  moveManager.cache = { 'old.md': moved };
  await assert.rejects(() => moveManager.move('old.md', 'new.md'), /disk full/, 'move must surface a rejected write');
  assert.deepStrictEqual(
    moveManager.cache,
    { 'old.md': moved },
    'a rejected move must not leave the entry under the new path',
  );

  const clearManager = makeManager(makeRejectingAdapter());
  const kept = makeEntry('kept');
  clearManager.cache = { 'a.md': kept };
  await assert.rejects(() => clearManager.clear(), /disk full/, 'clear must surface a rejected write');
  assert.deepStrictEqual(clearManager.cache, { 'a.md': kept }, 'a rejected clear must not empty the in-memory cache');
}

/**
 * flush() is the quit path's guarantee that pending cache work reached disk. A debounce
 * whose timer already fired leaves no timer behind, so flush() used to see "no timer" and
 * fire a SECOND, concurrent write of its own instead of awaiting the one already running.
 * (Unlike main.ts's flushSettingsSave it never lost the data outright — `_dirty` stayed
 * set until the write landed — but two concurrent writes to the same file can land out of
 * order, and a mutation arriving mid-write had its dirty flag cleared by that write.)
 */
async function testFlushAwaitsTheWriteAlreadyInFlight() {
  const writes = [];
  let resolveWrite = null;
  const adapter = {
    exists: async () => true,
    mkdir: async () => {},
    read: async () => '{}',
    write: async (_filePath, content) => {
      writes.push(content);
      return new Promise((resolve) => {
        resolveWrite = resolve;
      });
    },
  };

  const originalActiveWindow = globalThis.activeWindow;
  const pendingTimers = new Map();
  let nextTimerId = 1;
  globalThis.activeWindow = {
    setTimeout: (fn) => {
      const id = nextTimerId++;
      pendingTimers.set(id, fn);
      return id;
    },
    clearTimeout: (id) => {
      pendingTimers.delete(id);
    },
  };

  try {
    const manager = makeManager(adapter);
    manager.cache = { 'a.md': makeEntry('one') };
    manager.scheduleSave(5000);

    const [[timerId, fireTimer]] = pendingTimers;
    pendingTimers.delete(timerId);
    fireTimer(); // the debounce elapses: the write starts and is now in flight
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(writes.length, 1, 'sanity: the debounced write started');

    let flushResolved = false;
    const flush = manager.flush().then(() => {
      flushResolved = true;
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(writes.length, 1, 'flush must await the in-flight write, not race a second one past it');
    assert.strictEqual(flushResolved, false, 'flush must not resolve while the cache write it flushes is pending');

    resolveWrite();
    await flush;
    assert.strictEqual(flushResolved, true, 'flush resolves once the in-flight write lands');
    assert.strictEqual(writes.length, 1, 'one scheduled save produces exactly one write, even with a flush on top');
  } finally {
    globalThis.activeWindow = originalActiveWindow;
  }
}

async function testSuccessfulWriteKeepsTheMutation() {
  const writes = [];
  const adapter = {
    exists: async () => true,
    mkdir: async () => {},
    read: async () => '{}',
    write: async (filePath, content) => writes.push({ filePath, content }),
  };
  const manager = makeManager(adapter);
  manager.cache = { 'a.md': makeEntry('old') };

  assert.strictEqual(await manager.replaceCards('a.md', [{ title: 'new', anchor: '', gist: '', bullets: [] }]), true);
  assert.strictEqual(manager.cache['a.md'].cards[0].title, 'new', 'a successful write still commits the edit');
  assert.strictEqual(writes.length, 1, 'a successful replaceCards writes exactly once');
}

// ── pruneCacheEntries ──

const cache = {
  'a.md': { generatedAt: '2024-01-01' },
  'b.md': { generatedAt: '2024-01-03' },
  'c.md': { generatedAt: '2024-01-02', lastAccessedAt: '2024-01-05' },
};
const removed = t.pruneCacheEntries(cache, 2);
assert.deepStrictEqual(removed, ['a.md'], 'removes oldest by lastAccessedAt/generatedAt');
assert.strictEqual(Object.keys(cache).length, 2, 'cache pruned to max');
assert.ok(!cache['a.md'], 'oldest removed');
assert.ok(cache['b.md'] && cache['c.md'], 'newest kept');

const smallCache = { 'x.md': { generatedAt: '2024-01-01' } };
assert.deepStrictEqual(t.pruneCacheEntries(smallCache, 10), [], 'nothing pruned when under limit');

(async () => {
  await testCacheManagerMove();
  await testReplaceCardsRestoresEntryWhenWriteRejects();
  await testPutRestoresEntryWhenWriteRejects();
  await testDeleteRestoresEntryWhenWriteRejects();
  await testMoveAndClearRestoreCacheWhenWriteRejects();
  await testFlushAwaitsTheWriteAlreadyInFlight();
  await testSuccessfulWriteKeepsTheMutation();
  console.log('cache tests passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
