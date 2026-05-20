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
    assert.strictEqual(i18n.resolveUiLanguage({ uiLanguage: 'ja' }), 'ja');
    assert.strictEqual(i18n.resolveUiLanguage({ uiLanguage: 'ko' }), 'ko');
    assert.strictEqual(i18n.resolveUiLanguage({ uiLanguage: 'fr' }), 'fr');
    assert.strictEqual(i18n.resolveUiLanguage({ uiLanguage: 'de' }), 'de');
    assert.strictEqual(i18n.resolveUiLanguage({ uiLanguage: 'es' }), 'es');
    assert.strictEqual(i18n.resolveUiLanguage(null), 'en');
    assert.strictEqual(i18n.resolveUiLanguage({ uiLanguage: 'auto' }), 'en');
    assert.strictEqual(i18n.resolveUiLanguage({ uiLanguage: { toString: () => 'ja' } }), 'en');

    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const setNavigatorLanguage = (language) => {
      Object.defineProperty(globalThis, 'navigator', {
        value: { language },
        configurable: true,
      });
    };
    try {
      setNavigatorLanguage('ja-JP');
      assert.strictEqual(i18n.resolveUiLanguage({ uiLanguage: 'auto' }), 'ja');
      setNavigatorLanguage('ko-KR');
      assert.strictEqual(i18n.resolveUiLanguage({ uiLanguage: 'auto' }), 'ko');
      setNavigatorLanguage('fr-CA');
      assert.strictEqual(i18n.resolveUiLanguage({ uiLanguage: 'auto' }), 'fr');
      setNavigatorLanguage('de_DE');
      assert.strictEqual(i18n.resolveUiLanguage({ uiLanguage: 'auto' }), 'de');
      setNavigatorLanguage('es-MX');
      assert.strictEqual(i18n.resolveUiLanguage({ uiLanguage: 'auto' }), 'es');
      setNavigatorLanguage('it-IT');
      assert.strictEqual(i18n.resolveUiLanguage({ uiLanguage: 'auto' }), 'en');
    } finally {
      if (originalNavigator) {
        Object.defineProperty(globalThis, 'navigator', originalNavigator);
      } else {
        delete globalThis.navigator;
      }
    }

    assert.ok(i18n.STRINGS.zh);
    assert.ok(i18n.STRINGS.en);
    assert.ok(i18n.STRINGS.ja);
    assert.ok(i18n.STRINGS.ko);
    assert.ok(i18n.STRINGS.fr);
    assert.ok(i18n.STRINGS.de);
    assert.ok(i18n.STRINGS.es);
    const supportedLocales = ['zh', 'en', 'ja', 'ko', 'fr', 'de', 'es'];
    const enKeys = Object.keys(i18n.STRINGS.en).sort();
    for (const locale of supportedLocales) {
      const keys = Object.keys(i18n.STRINGS[locale]).sort();
      assert.deepStrictEqual(keys, enKeys, `${locale} keys must match en`);
      for (const key of enKeys) {
        assert.ok(i18n.STRINGS[locale][key], `${locale} empty key: ${key}`);
      }
    }
    for (const locale of ['ja', 'ko', 'fr', 'de', 'es']) {
      const overrideKeys = Object.keys(i18n.LOCALE_OVERRIDES[locale]).sort();
      assert.deepStrictEqual(overrideKeys, enKeys, `${locale} raw override keys must match en`);
      for (const key of enKeys) {
        assert.ok(i18n.LOCALE_OVERRIDES[locale][key], `${locale} empty raw override: ${key}`);
      }
    }

    console.log('direct i18n tests passed');
  } finally {
    cleanup();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
