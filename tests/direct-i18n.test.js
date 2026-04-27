const { assert, requireBundledModule, cleanup } = require('./direct-test-setup');

(async () => {
  try {
    const i18n = await requireBundledModule('src/i18n.ts');

    assert.strictEqual(i18n.translate({ uiLanguage: 'en' }, 'displayName'), 'Parallel Reader');
    assert.strictEqual(i18n.translate({ uiLanguage: 'zh' }, 'displayName'), '对照阅读笔记');
    assert.strictEqual(
      i18n.translate({ uiLanguage: 'en' }, 'cacheClearedFile', { name: 'test.md' }),
      'Cleared cache: test.md',
    );
    assert.strictEqual(
      i18n.translate({ uiLanguage: 'en' }, 'generationDone', { count: 5, suffix: '' }),
      'Generated 5 sections',
    );
    assert.strictEqual(
      i18n.translate({ uiLanguage: 'en' }, 'errorProviderApiStatus', {
        label: 'OpenAI',
        status: 429,
        excerpt: 'rate limited',
      }),
      'OpenAI API returned HTTP 429: rate limited',
    );
    assert.strictEqual(i18n.translate({ uiLanguage: 'en' }, 'nonExistentKey123'), 'nonExistentKey123');
    assert.ok(i18n.translate(null, 'displayName').length > 0);
    assert.strictEqual(i18n.translate({ uiLanguage: 'en' }, 'cacheClearedFile'), 'Cleared cache: {name}');

    assert.strictEqual(i18n.resolveUiLanguage({ uiLanguage: 'en' }), 'en');
    assert.strictEqual(i18n.resolveUiLanguage({ uiLanguage: 'zh' }), 'zh');
    assert.strictEqual(i18n.resolveUiLanguage(null), 'en');
    assert.strictEqual(i18n.resolveUiLanguage({ uiLanguage: 'auto' }), 'en');

    assert.ok(i18n.STRINGS.zh);
    assert.ok(i18n.STRINGS.en);
    const zhKeys = Object.keys(i18n.STRINGS.zh);
    const enKeys = Object.keys(i18n.STRINGS.en);
    assert.strictEqual(zhKeys.length, enKeys.length);
    for (const key of zhKeys) {
      assert.ok(i18n.STRINGS.en[key], `en missing key: ${key}`);
    }

    console.log('direct i18n tests passed');
  } finally {
    cleanup();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
