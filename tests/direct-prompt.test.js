const { assert, requireBundledModule, cleanup } = require('./direct-test-setup');

(async () => {
  try {
    const prompt = await requireBundledModule('src/prompt.ts');
    const settings = await requireBundledModule('src/settings.ts');
    const base = { ...settings.DEFAULT_SETTINGS, promptLanguage: 'en', minCards: 3, maxCards: 7 };

    // ── promptLanguageInstruction ──
    assert.strictEqual(prompt.promptLanguageInstruction('en'), 'Write title, gist, and bullets in English.');
    assert.strictEqual(prompt.promptLanguageInstruction('zh'), '用中文输出 title、gist 和 bullets。');
    assert.strictEqual(prompt.promptLanguageInstruction('auto'), 'Write title, gist, and bullets in the main language of the source document.');
    assert.strictEqual(prompt.promptLanguageInstruction('fr'), '用中文输出 title、gist 和 bullets。', 'unknown language falls to zh');

    // ── promptSchemaExample ──
    const enExample = prompt.promptSchemaExample('en');
    assert.ok(enExample.includes('U-shaped gains'), 'en example has expected title');
    assert.ok(enExample.includes('"cards"'), 'en example is JSON-like');

    const zhExample = prompt.promptSchemaExample('zh');
    assert.ok(zhExample.includes('U 型收益曲线'), 'zh example has expected title');
    assert.ok(zhExample.includes('"cards"'), 'zh example is JSON-like');

    assert.ok(prompt.promptSchemaExample('auto').includes('U 型收益曲线'), 'auto falls to zh example');

    // ── renderPromptTemplate ──
    assert.strictEqual(prompt.renderPromptTemplate('Hello {name}!', { name: 'World' }), 'Hello World!');
    assert.strictEqual(prompt.renderPromptTemplate('{a} and {b}', { a: 1, b: 2 }), '1 and 2', 'numeric vars');
    assert.strictEqual(prompt.renderPromptTemplate('{missing}', {}), '{missing}', 'unmatched placeholder preserved');
    assert.strictEqual(prompt.renderPromptTemplate('no vars', {}), 'no vars', 'no placeholders');
    assert.strictEqual(prompt.renderPromptTemplate('', { a: 1 }), '', 'empty template');
    assert.strictEqual(prompt.renderPromptTemplate(null, { a: 1 }), '', 'null template returns empty string');

    // ── buildPrompts: basic en ──
    const enResult = prompt.buildPrompts('Hello world', base);
    assert.ok(enResult.system.includes('3-7'), 'en card range in system');
    assert.ok(enResult.system.includes('English'), 'en language instruction');
    assert.ok(enResult.user.includes('Source document:'), 'en user prefix');
    assert.ok(enResult.user.includes('Hello world'), 'en content');

    // ── buildPrompts: basic zh ──
    const zhResult = prompt.buildPrompts('你好', { ...base, promptLanguage: 'zh' });
    assert.ok(zhResult.system.includes('3-7'), 'zh card range');
    assert.ok(zhResult.system.includes('中文'), 'zh language instruction');
    assert.ok(zhResult.user.includes('以下是需要处理的文档全文'), 'zh user prefix');

    // ── buildPrompts: auto language ──
    const autoResult = prompt.buildPrompts('content', { ...base, promptLanguage: 'auto' });
    assert.ok(autoResult.system.includes('main language'), 'auto language instruction');

    // ── buildPrompts: truncation ──
    const longDoc = 'x'.repeat(25000);
    const truncResult = prompt.buildPrompts(longDoc, { ...base, maxDocChars: 20000 });
    assert.ok(truncResult.user.includes('[Document truncated]'), 'en truncation marker');
    assert.ok(truncResult.user.length < 25000, 'content truncated');

    const zhTrunc = prompt.buildPrompts(longDoc, { ...base, promptLanguage: 'zh', maxDocChars: 20000 });
    assert.ok(zhTrunc.user.includes('[文档过长，已截断]'), 'zh truncation marker');

    // ── buildPrompts: custom system prompt ──
    const custom = prompt.buildPrompts('doc', {
      ...base,
      customSystemPrompt: 'Custom: {minCards}-{maxCards} cards. {languageInstruction}',
    });
    assert.ok(custom.system.includes('Custom: 3-7 cards'), 'custom template vars substituted');
    assert.ok(custom.system.includes('Non-overridable output contract'), 'contract appended');
    assert.ok(!custom.system.includes('long-form reading'), 'default prompt NOT included when custom set');

    // ── buildPrompts: empty custom prompt uses default ──
    const emptyCustom = prompt.buildPrompts('doc', { ...base, customSystemPrompt: '' });
    assert.ok(emptyCustom.system.includes('long-form reading'), 'default prompt used when custom is empty');

    // ── buildPrompts: whitespace-only custom prompt uses default ──
    const wsCustom = prompt.buildPrompts('doc', { ...base, customSystemPrompt: '   ' });
    assert.ok(wsCustom.system.includes('long-form reading'), 'default prompt used when custom is whitespace-only');

    // ── buildPrompts: invalid promptLanguage falls back ──
    const badLang = prompt.buildPrompts('doc', { ...base, promptLanguage: 'xyz' });
    assert.ok(badLang.system.includes('中文'), 'invalid promptLanguage falls back to zh default');

    // ── buildPrompts: card count normalization ──
    // 0 is falsy so || picks DEFAULT (5), then Math.max(1, 5) = 5
    const zeroCards = prompt.buildPrompts('doc', { ...base, minCards: 0, maxCards: 0 });
    assert.ok(zeroCards.system.includes('5-'), 'zero minCards falls back to default');

    const bigCards = prompt.buildPrompts('doc', { ...base, minCards: 5, maxCards: 3 });
    assert.ok(bigCards.system.includes('5-5'), 'maxCards raised to match minCards');

    // ── buildPrompts: maxDocChars normalization ──
    const defaultMax = prompt.buildPrompts('doc', { ...base, maxDocChars: undefined });
    assert.ok(defaultMax.user.includes('doc'), 'undefined maxDocChars uses default without truncation');

    console.log('direct prompt tests passed');
  } finally {
    cleanup();
  }
})().catch((e) => { console.error(e); process.exit(1); });
