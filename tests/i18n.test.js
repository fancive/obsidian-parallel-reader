const { assert, t } = require('./test-setup');

assert.strictEqual(t.translate({ uiLanguage: 'zh' }, 'appTitle'), '对照阅读笔记', 'zh translation');
assert.strictEqual(t.translate({ uiLanguage: 'en' }, 'appTitle'), 'Parallel Reader', 'en translation');
assert.strictEqual(t.translate({ uiLanguage: 'en' }, 'nonexistent_key'), 'nonexistent_key', 'missing key returns key');
assert.strictEqual(
  t.translate({ uiLanguage: 'en' }, 'cacheClearedAll', { count: 5 }),
  'Cleared 5 cache entries',
  'variable interpolation',
);
assert.strictEqual(
  t.translate({ uiLanguage: 'en' }, 'exported', { path: 'foo/bar.md' }),
  'Exported → foo/bar.md',
  'path variable',
);
assert.strictEqual(
  t.translate(null, 'appTitle'),
  'Parallel Reader',
  'null settings defaults to en in Node.js (no navigator)',
);
assert.strictEqual(
  t.translate({ uiLanguage: 'en' }, 'generationDone', { count: 3, suffix: '' }),
  'Generated 3 sections',
  'variable interpolation with multiple vars',
);
assert.strictEqual(t.translate({ uiLanguage: 'zh' }, 'appTitle'), '对照阅读笔记', 'zh translation for appTitle');
assert.strictEqual(t.translate({ uiLanguage: 'en' }, '__no_such_key__'), '__no_such_key__', 'missing key returns key');
assert.strictEqual(t.translate({ uiLanguage: 'zh' }, 'settingTestBackendButton'), '测试');
assert.strictEqual(t.translate({ uiLanguage: 'en' }, 'confirmRegenerateProceed'), 'Regenerate');
assert.strictEqual(
  t.translate({ uiLanguage: 'en' }, 'confirmExportOverwrite', { path: 'Reading/A.md' }),
  'Export file already exists: Reading/A.md\nOverwrite it?',
);
assert.strictEqual(t.translate({ uiLanguage: 'zh' }, 'batchFolderConfirm'), '确定');

console.log('i18n tests passed');
