const { assert, requireBundledModule, cleanup } = require('./direct-test-setup');

function createFakeAdapter() {
  const files = new Map();
  const dirs = new Set();
  return {
    files,
    dirs,
    writes: [],
    exists: async (filePath) => dirs.has(filePath) || files.has(filePath),
    mkdir: async (filePath) => {
      dirs.add(filePath);
    },
    read: async (filePath) => {
      if (!files.has(filePath)) throw new Error('not found');
      return files.get(filePath);
    },
    write: async (filePath, content) => {
      files.set(filePath, content);
      return files.get(filePath);
    },
  };
}

(async () => {
  try {
    const cache = await requireBundledModule('src/cache.ts');
    const cacheManagerModule = await requireBundledModule('src/cache-manager.ts');
    const settings = await requireBundledModule('src/settings.ts');

    // ── cache.ts ──
    const cacheEntry = { generatedAt: '2024-01-01T00:00:00.000Z' };
    const touched = cache.touchCacheEntry(cacheEntry, '2024-06-01T00:00:00.000Z');
    assert.strictEqual(touched.lastAccessedAt, '2024-06-01T00:00:00.000Z', 'direct cache import touches entries');
    assert.strictEqual(cacheEntry.lastAccessedAt, undefined, 'direct cache import keeps cache entries immutable');
    assert.strictEqual(JSON.parse(cache.serializeCacheFile({ 'a.md': { cards: [] } })).version, 1);

    // ── CacheManager: load + prune ──
    const adapter = createFakeAdapter();
    const manager = new cacheManagerModule.CacheManager(adapter, '.obsidian', 'parallel-reader', () => ({
      ...settings.DEFAULT_SETTINGS,
      maxCacheEntries: 2,
    }));
    adapter.files.set(
      manager.filePath(),
      JSON.stringify({
        version: 1,
        entries: {
          'old.md': { generatedAt: '2024-01-01T00:00:00.000Z', cards: [] },
          'fresh.md': { generatedAt: '2024-01-02T00:00:00.000Z', cards: [] },
          'touched.md': {
            generatedAt: '2024-01-03T00:00:00.000Z',
            lastAccessedAt: '2024-02-01T00:00:00.000Z',
            cards: [],
          },
        },
      }),
    );
    await manager.load();
    assert.strictEqual(manager.cache['old.md'], undefined, 'CacheManager.load prunes old entries');
    assert.ok(adapter.files.get(manager.filePath()).includes('fresh.md'), 'CacheManager.load persists prune results');

    const touchedEntry = await manager.touch('fresh.md');
    assert.ok(touchedEntry.lastAccessedAt, 'CacheManager.touch updates existing entries');
    await manager.flush();
    assert.ok(JSON.parse(adapter.files.get(manager.filePath())).entries['fresh.md'].lastAccessedAt);

    assert.strictEqual(
      await manager.replaceCards('fresh.md', [
        { title: 'New', anchor: 'A', gist: 'G', bullets: ['B'], level: 2, startLine: 1 },
      ]),
      true,
      'CacheManager.replaceCards updates existing entries',
    );
    assert.strictEqual(JSON.parse(adapter.files.get(manager.filePath())).entries['fresh.md'].cards[0].title, 'New');

    await manager.delete('fresh.md');
    assert.strictEqual(manager.cache['fresh.md'], undefined, 'CacheManager.delete removes entries');

    manager.cache = { 'clear.md': { generatedAt: '2024-01-04T00:00:00.000Z', cards: [] } };
    await manager.save();
    assert.ok(adapter.files.get(manager.filePath()).includes('clear.md'), 'CacheManager.save persists current cache');
    await manager.clear();
    assert.deepStrictEqual(manager.cache, {}, 'CacheManager.clear resets cache state');

    // ── Cache pruning interleaved with put ──
    const pruneAdapter = createFakeAdapter();
    const pruneManager = new cacheManagerModule.CacheManager(pruneAdapter, '.obsidian', 'parallel-reader', () => ({
      ...settings.DEFAULT_SETTINGS,
      maxCacheEntries: 2,
    }));
    await pruneManager.load();
    pruneManager.cache = {
      'old.md': {
        schemaVersion: 2,
        contentHash: 'a',
        settingsHash: 'a',
        cards: [],
        generatedAt: '2024-01-01T00:00:00.000Z',
        lastAccessedAt: '2024-01-01T00:00:00.000Z',
      },
      'mid.md': {
        schemaVersion: 2,
        contentHash: 'b',
        settingsHash: 'b',
        cards: [],
        generatedAt: '2024-06-01T00:00:00.000Z',
        lastAccessedAt: '2024-06-01T00:00:00.000Z',
      },
    };
    await pruneManager.put(
      'new.md',
      'new content',
      [{ title: 'N', anchor: 'n', gist: 'g', bullets: [] }],
      settings.DEFAULT_SETTINGS,
    );
    assert.strictEqual(Object.keys(pruneManager.cache).length, 2, 'cache pruned to max entries after put');
    assert.ok(pruneManager.cache['new.md'], 'newest entry survives pruning');
    assert.strictEqual(pruneManager.cache['old.md'], undefined, 'oldest entry pruned by timestamp');
    const persistedPrune = JSON.parse(pruneAdapter.files.get(pruneManager.filePath()));
    assert.ok(persistedPrune.entries['new.md'], 'newest entry persisted after pruning');

    // ── CacheManager.get() ──
    assert.strictEqual(pruneManager.get('new.md').cards[0].title, 'N', 'CacheManager.get returns existing entry');
    assert.strictEqual(pruneManager.get('nonexistent.md'), null, 'CacheManager.get returns null for missing entry');

    // ── CacheManager.move() ──
    const moveAdapter = createFakeAdapter();
    const moveManager = new cacheManagerModule.CacheManager(
      moveAdapter,
      '.obsidian',
      'parallel-reader',
      () => settings.DEFAULT_SETTINGS,
    );
    await moveManager.load();
    moveManager.cache = {
      'a.md': {
        schemaVersion: 2,
        contentHash: 'a',
        settingsHash: 'a',
        cards: [{ title: 'A', anchor: 'a', gist: 'g', bullets: [] }],
        generatedAt: '2024-01-01T00:00:00.000Z',
      },
      'b.md': {
        schemaVersion: 2,
        contentHash: 'b',
        settingsHash: 'b',
        cards: [],
        generatedAt: '2024-01-02T00:00:00.000Z',
      },
    };
    await moveManager.save();
    assert.strictEqual(await moveManager.move('a.md', 'renamed.md'), true, 'move returns true on success');
    assert.strictEqual(moveManager.get('a.md'), null, 'move removes old path');
    assert.strictEqual(moveManager.get('renamed.md').cards[0].title, 'A', 'move preserves entry at new path');
    assert.strictEqual(await moveManager.move('renamed.md', 'b.md'), false, 'move rejects when destination exists');
    assert.strictEqual(await moveManager.move('b.md', 'b.md'), true, 'same-path returns true if entry exists');
    assert.strictEqual(await moveManager.move('gone.md', 'gone.md'), false, 'same-path returns false if missing');
    assert.strictEqual(await moveManager.move('', 'dest.md'), false, 'rejects empty oldPath');
    assert.strictEqual(await moveManager.move('  ', 'dest.md'), false, 'rejects whitespace oldPath');

    // ── CacheManager.readFile() with corrupt JSON ──
    const corruptAdapter = createFakeAdapter();
    const corruptManager = new cacheManagerModule.CacheManager(
      corruptAdapter,
      '.obsidian',
      'parallel-reader',
      () => settings.DEFAULT_SETTINGS,
    );
    corruptAdapter.files.set(corruptManager.filePath(), '{ invalid json !!!');
    assert.deepStrictEqual(await corruptManager.readFile(), {}, 'readFile returns empty object for corrupt JSON');

    const noEntriesAdapter = createFakeAdapter();
    const noEntriesManager = new cacheManagerModule.CacheManager(
      noEntriesAdapter,
      '.obsidian',
      'parallel-reader',
      () => settings.DEFAULT_SETTINGS,
    );
    noEntriesAdapter.files.set(noEntriesManager.filePath(), JSON.stringify({ version: 1 }));
    assert.deepStrictEqual(
      await noEntriesManager.readFile(),
      {},
      'readFile returns empty object when no entries field',
    );

    // ── CacheManager.pruneIfNeeded() ──
    const pruneNeededAdapter = createFakeAdapter();
    const pruneNeededManager = new cacheManagerModule.CacheManager(
      pruneNeededAdapter,
      '.obsidian',
      'parallel-reader',
      () => ({
        ...settings.DEFAULT_SETTINGS,
        maxCacheEntries: 1,
      }),
    );
    await pruneNeededManager.load();
    pruneNeededManager.cache = {
      'old.md': {
        schemaVersion: 2,
        contentHash: 'a',
        settingsHash: 'a',
        cards: [],
        generatedAt: '2024-01-01T00:00:00.000Z',
        lastAccessedAt: '2024-01-01T00:00:00.000Z',
      },
      'new.md': {
        schemaVersion: 2,
        contentHash: 'b',
        settingsHash: 'b',
        cards: [],
        generatedAt: '2024-06-01T00:00:00.000Z',
        lastAccessedAt: '2024-06-01T00:00:00.000Z',
      },
    };
    const pruneIfResult = await pruneNeededManager.pruneIfNeeded();
    assert.strictEqual(pruneIfResult.length, 1, 'pruneIfNeeded returns removed keys');
    assert.strictEqual(pruneIfResult[0], 'old.md', 'pruneIfNeeded removes oldest');

    const noPruneAdapter = createFakeAdapter();
    const noPruneManager = new cacheManagerModule.CacheManager(noPruneAdapter, '.obsidian', 'parallel-reader', () => ({
      ...settings.DEFAULT_SETTINGS,
      maxCacheEntries: 100,
    }));
    await noPruneManager.load();
    noPruneManager.cache = {
      'only.md': {
        schemaVersion: 2,
        contentHash: 'a',
        settingsHash: 'a',
        cards: [],
        generatedAt: '2024-01-01T00:00:00.000Z',
      },
    };
    assert.strictEqual(
      (await noPruneManager.pruneIfNeeded()).length,
      0,
      'pruneIfNeeded returns empty when nothing to prune',
    );

    assert.strictEqual(
      await pruneNeededManager.replaceCards('nonexistent.md', []),
      false,
      'replaceCards returns false for missing entry',
    );

    // ── CacheManager.scheduleSave() + flush() ──
    const scheduleAdapter = createFakeAdapter();
    const scheduleManager = new cacheManagerModule.CacheManager(
      scheduleAdapter,
      '.obsidian',
      'parallel-reader',
      () => settings.DEFAULT_SETTINGS,
    );
    await scheduleManager.load();
    scheduleManager.cache = {
      'sched.md': {
        schemaVersion: 2,
        contentHash: 'x',
        settingsHash: 'x',
        cards: [],
        generatedAt: '2024-01-01T00:00:00.000Z',
      },
    };
    scheduleManager.scheduleSave(50000);
    await scheduleManager.flush();
    assert.ok(
      JSON.parse(scheduleAdapter.files.get(scheduleManager.filePath())).entries['sched.md'],
      'flush persists scheduled save',
    );

    scheduleAdapter.files.delete(scheduleManager.filePath());
    await scheduleManager.flush();
    assert.strictEqual(scheduleAdapter.files.has(scheduleManager.filePath()), false, 'flush is no-op when not dirty');

    // ── readFile drops malformed entries (cards not array / bullets not array) ──
    {
      const validateAdapter = createFakeAdapter();
      const validateManager = new cacheManagerModule.CacheManager(
        validateAdapter,
        '.obsidian',
        'parallel-reader',
        () => ({ ...settings.DEFAULT_SETTINGS, maxCacheEntries: 100 }),
      );
      validateAdapter.files.set(
        validateManager.filePath(),
        JSON.stringify({
          version: 1,
          entries: {
            'good.md': { generatedAt: '2024-01-01T00:00:00.000Z', cards: [{ title: 't', bullets: ['x'] }] },
            'cards-null.md': { cards: null },
            'cards-string.md': { cards: 'oops' },
            'bullets-string.md': { cards: [{ title: 't', bullets: 'not-array' }] },
            'bullets-missing.md': { cards: [{ title: 't' }] }, // tolerated
            'card-null.md': { cards: [null] }, // dangerous: c.anchor would crash
            'anchor-number.md': { cards: [{ anchor: 42, bullets: [] }] }, // dangerous: anchor.trim() would crash
            'not-an-object.md': 42,
            'null-entry.md': null,
          },
        }),
      );
      const origWarn = console.warn;
      let droppedMessage = '';
      console.warn = (...args) => {
        droppedMessage = args.join(' ');
      };
      try {
        const loaded = await validateManager.readFile();
        assert.ok(loaded['good.md'], 'good entry kept');
        assert.ok(loaded['bullets-missing.md'], 'entry with missing bullets tolerated (defaults to [])');
        assert.strictEqual(loaded['cards-null.md'], undefined, 'cards=null dropped');
        assert.strictEqual(loaded['cards-string.md'], undefined, 'cards=string dropped');
        assert.strictEqual(loaded['bullets-string.md'], undefined, 'bullets=string dropped');
        assert.strictEqual(loaded['card-null.md'], undefined, 'cards=[null] dropped');
        assert.strictEqual(loaded['anchor-number.md'], undefined, 'anchor=number dropped');
        assert.strictEqual(loaded['not-an-object.md'], undefined, 'non-object entry dropped');
        assert.strictEqual(loaded['null-entry.md'], undefined, 'null entry dropped');
        assert.ok(/dropped 7 malformed/.test(droppedMessage), 'console.warn reports drop count');
      } finally {
        console.warn = origWarn;
      }
    }

    // ── readFile tolerates parsed=null / non-object entries field ──
    {
      const edgeAdapter = createFakeAdapter();
      const edgeManager = new cacheManagerModule.CacheManager(
        edgeAdapter,
        '.obsidian',
        'parallel-reader',
        () => settings.DEFAULT_SETTINGS,
      );
      edgeAdapter.files.set(edgeManager.filePath(), JSON.stringify(null));
      assert.deepStrictEqual(await edgeManager.readFile(), {}, 'parsed=null returns empty cache');
      edgeAdapter.files.set(edgeManager.filePath(), JSON.stringify({ entries: 'oops' }));
      assert.deepStrictEqual(await edgeManager.readFile(), {}, 'entries=non-object returns empty cache');
    }

    console.log('direct cache tests passed');
  } finally {
    cleanup();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
