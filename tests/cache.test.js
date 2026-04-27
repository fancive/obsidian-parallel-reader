const { assert, t } = require('./test-setup');

// ── touchCacheEntry / serializeCacheFile / shouldConfirmRegenerate ──

assert.strictEqual(t.touchCacheEntry(null), null, 'touchCacheEntry on null returns null');
const entry = { generatedAt: '2024-01-01T00:00:00.000Z' };
const touched = t.touchCacheEntry(entry, '2024-06-01T00:00:00.000Z');
assert.strictEqual(touched.lastAccessedAt, '2024-06-01T00:00:00.000Z', 'touchCacheEntry sets lastAccessedAt on returned entry');
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
  assert.strictEqual(await manager.move('old.md', 'other.md'), false, 'move does not overwrite an existing target path');
  assert.strictEqual(writes.length, 0, 'no-op and rejected cache moves are not persisted');
  assert.strictEqual(await manager.move('old.md', 'new.md'), true, 'existing cache move returns true');
  assert.strictEqual(manager.cache['old.md'], undefined, 'old cache path is removed');
  assert.deepStrictEqual(manager.cache['new.md'], cacheEntry, 'cache entry is moved to new path');
  assert.ok(manager.cache['other.md'], 'unrelated cache entries remain');
  assert.strictEqual(writes.length, 1, 'successful cache move is persisted once');
  assert.ok(JSON.parse(writes[0].content).entries['new.md'], 'persisted cache uses moved path');
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
  console.log('cache tests passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
