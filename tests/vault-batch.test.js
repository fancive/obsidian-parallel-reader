const { assert, t } = require('./test-setup');

// ── vault.ts ──

assert.deepStrictEqual(t.folderPathsForTarget(''), [], 'empty path');
assert.deepStrictEqual(t.folderPathsForTarget('A/B/C'), ['A', 'A/B', 'A/B/C']);
assert.deepStrictEqual(t.folderPathsForTarget('/A//B/'), ['A', 'A/B'], 'normalizes slashes');
assert.deepStrictEqual(t.folderPathsForTarget('single'), ['single']);
assert.deepStrictEqual(t.folderPathsForTarget('../../etc/passwd'), ['etc', 'etc/passwd'], 'strips .. path traversal');
assert.deepStrictEqual(t.folderPathsForTarget('./a/../b'), ['a', 'a/b'], 'strips . and .. segments');
assert.deepStrictEqual(t.folderPathsForTarget('a/../../b'), ['a', 'a/b'], 'strips mid-path ..');

// ── batch.ts ──

assert.strictEqual(t.normalizeBatchFolderInput('/Reading//Articles/'), 'Reading/Articles', 'normalizes folder input');
assert.strictEqual(t.normalizeBatchFolderInput('../Inbox/./Daily'), 'Inbox/Daily', 'strips unsafe folder segments');
assert.strictEqual(t.hasUnsafeBatchFolderSegments('../Inbox/./Daily'), true, 'unsafe folder segments are detected');
assert.strictEqual(t.hasUnsafeBatchFolderSegments('/Reading//Articles/'), false, 'normal folder paths are safe');
assert.deepStrictEqual(
  t.validateBatchFolderInput('', () => false),
  { valid: true, reason: 'ok', folderPath: '' },
  'empty batch folder targets vault root',
);
assert.deepStrictEqual(
  t.validateBatchFolderInput('Reading', (path) => path === 'Reading'),
  { valid: true, reason: 'ok', folderPath: 'Reading' },
  'existing folder input is valid',
);
assert.deepStrictEqual(
  t.validateBatchFolderInput('../Reading', () => true),
  { valid: false, reason: 'unsafe', folderPath: 'Reading' },
  'unsafe folder input is invalid even if normalized target exists',
);
assert.deepStrictEqual(
  t.validateBatchFolderInput('Missing', () => false),
  { valid: false, reason: 'missing', folderPath: 'Missing' },
  'missing folder input is invalid',
);
const batchFiles = [
  { path: 'root.md', parent: null },
  { path: 'Reading/note.md', parent: { path: 'Reading' } },
  { path: 'Reading/Deep/nested.md', parent: { path: 'Reading/Deep' } },
];
assert.deepStrictEqual(t.selectBatchFiles(batchFiles, '').map((file) => file.path), ['root.md'], 'root folder only');
assert.deepStrictEqual(
  t.selectBatchFiles(batchFiles, '/Reading/').map((file) => file.path),
  ['Reading/note.md'],
  'selected folder is non-recursive',
);
assert.deepStrictEqual(t.batchProgressVars(1, 3), { current: 2, total: 3 }, 'progress vars are one-based');
const batchStats = t.createBatchStats(3);
const skippedStats = t.recordBatchSkip(batchStats);
const processedStats = t.recordBatchProcessed(skippedStats);
const errorStats = t.recordBatchError(processedStats);
assert.deepStrictEqual(batchStats, { total: 3, processed: 0, skipped: 0, errors: 0 }, 'batch stats are immutable');
assert.deepStrictEqual(skippedStats, { total: 3, processed: 1, skipped: 1, errors: 0 }, 'batch skip updates progress');
assert.deepStrictEqual(processedStats, { total: 3, processed: 2, skipped: 1, errors: 0 }, 'batch processed count accumulates');
assert.deepStrictEqual(errorStats, { total: 3, processed: 3, skipped: 1, errors: 1 }, 'batch error count accumulates');

const batchState = t.createBatchRunState();
assert.deepStrictEqual(batchState, { cancelled: false, currentPath: '' }, 'batch state starts idle');
assert.strictEqual(t.markBatchFileRunning(batchState, 'Reading/a.md'), batchState, 'batch state updates in place');
assert.strictEqual(batchState.currentPath, 'Reading/a.md', 'batch state records current file');
assert.strictEqual(t.requestBatchCancel(batchState), true, 'first batch cancellation request succeeds');
assert.strictEqual(batchState.cancelled, true, 'batch cancellation flag is set');
assert.strictEqual(t.requestBatchCancel(batchState), false, 'duplicate batch cancellation request is ignored');
assert.strictEqual(t.requestBatchCancel(null), false, 'missing batch state cannot be cancelled');

const batchA = t.createBatchRunState();
const batchB = t.createBatchRunState();
t.markBatchFileRunning(batchA, 'folderA/note.md');
t.markBatchFileRunning(batchB, 'folderB/note.md');
assert.strictEqual(batchA.currentPath, 'folderA/note.md', 'batch A tracks its own file');
assert.strictEqual(batchB.currentPath, 'folderB/note.md', 'batch B tracks its own file');
t.requestBatchCancel(batchA);
assert.strictEqual(batchA.cancelled, true, 'batch A cancelled');
assert.strictEqual(batchB.cancelled, false, 'batch B unaffected by A cancellation');

const midCancelStats = t.createBatchStats(5);
const s1 = t.recordBatchProcessed(midCancelStats);
const s2 = t.recordBatchSkip(s1);
assert.strictEqual(s2.processed, 2, 'two files processed before cancel');
assert.strictEqual(s2.skipped, 1, 'one skipped before cancel');
assert.strictEqual(s2.errors, 0, 'no errors before cancel');
assert.strictEqual(s2.total, 5, 'total unchanged by partial processing');

console.log('vault-batch tests passed');
