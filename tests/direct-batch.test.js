const { assert, requireBundledModule, cleanup } = require('./direct-test-setup');

(async () => {
  try {
    const batch = await requireBundledModule('src/batch.ts');

    // ── isFileInBatchFolder (not tested directly before) ──
    assert.strictEqual(batch.isFileInBatchFolder({ path: 'root.md', parent: null }, ''), true, 'root file in root folder');
    assert.strictEqual(batch.isFileInBatchFolder({ path: 'sub/note.md', parent: { path: 'sub' } }, ''), false, 'subfolder file NOT in root folder');
    assert.strictEqual(batch.isFileInBatchFolder({ path: 'sub/note.md', parent: { path: 'sub' } }, 'sub'), true, 'file in matching folder');
    assert.strictEqual(batch.isFileInBatchFolder({ path: 'sub/deep/note.md', parent: { path: 'sub/deep' } }, 'sub'), false, 'nested file NOT in parent');
    assert.strictEqual(batch.isFileInBatchFolder({ path: 'note.md', parent: undefined }, ''), true, 'undefined parent in root');

    // ── normalizeBatchFolderInput edge cases ──
    assert.strictEqual(batch.normalizeBatchFolderInput(null), '', 'null input');
    assert.strictEqual(batch.normalizeBatchFolderInput(undefined), '', 'undefined input');
    assert.strictEqual(batch.normalizeBatchFolderInput(''), '', 'empty string');
    assert.strictEqual(batch.normalizeBatchFolderInput('///'), '', 'only slashes');
    assert.strictEqual(batch.normalizeBatchFolderInput(' a / b / c '), 'a/b/c', 'trims each segment');
    assert.strictEqual(batch.normalizeBatchFolderInput('./a/../b/.'), 'a/b', 'strips . and ..');

    // ── hasUnsafeBatchFolderSegments edge cases ──
    assert.strictEqual(batch.hasUnsafeBatchFolderSegments(null), false, 'null is safe');
    assert.strictEqual(batch.hasUnsafeBatchFolderSegments(''), false, 'empty is safe');
    assert.strictEqual(batch.hasUnsafeBatchFolderSegments('.'), true, 'single dot unsafe');
    assert.strictEqual(batch.hasUnsafeBatchFolderSegments('..'), true, 'double dot unsafe');
    assert.strictEqual(batch.hasUnsafeBatchFolderSegments('a/./b'), true, 'mid-path dot unsafe');
    assert.strictEqual(batch.hasUnsafeBatchFolderSegments('a/.b/c'), false, 'dotfile is safe');

    // ── selectBatchFiles with more complex structures ──
    const files = [
      { path: 'root.md', parent: null },
      { path: 'A/note.md', parent: { path: 'A' } },
      { path: 'A/deep/note.md', parent: { path: 'A/deep' } },
      { path: 'B/note.md', parent: { path: 'B' } },
    ];
    assert.strictEqual(batch.selectBatchFiles(files, 'A').length, 1, 'non-recursive: only A/note.md');
    assert.strictEqual(batch.selectBatchFiles(files, 'A')[0].path, 'A/note.md');
    assert.strictEqual(batch.selectBatchFiles(files, 'A/deep').length, 1, 'deep folder');
    assert.strictEqual(batch.selectBatchFiles(files, 'nonexistent').length, 0, 'missing folder');
    assert.strictEqual(batch.selectBatchFiles([], 'A').length, 0, 'empty file list');

    // ── shouldSkipBatchFile ──
    assert.strictEqual(batch.shouldSkipBatchFile(null, 'content', {}), false, 'null entry not skipped');

    // ── stats immutability ──
    const s1 = batch.createBatchStats(10);
    const s2 = batch.recordBatchProcessed(s1);
    const s3 = batch.recordBatchSkip(s2);
    const s4 = batch.recordBatchError(s3);
    assert.deepStrictEqual(s1, { total: 10, processed: 0, skipped: 0, errors: 0 }, 'original untouched');
    assert.strictEqual(s4.processed, 3, 'all three increments');
    assert.strictEqual(s4.skipped, 1);
    assert.strictEqual(s4.errors, 1);

    console.log('direct batch tests passed');
  } finally {
    cleanup();
  }
})().catch((e) => { console.error(e); process.exit(1); });
