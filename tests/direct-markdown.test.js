const { assert, requireBundledModule, cleanup } = require('./direct-test-setup');

(async () => {
  try {
    const md = await requireBundledModule('src/markdown.ts');

    // ── cardToMarkdown ──
    const full = md.cardToMarkdown({
      title: 'Section A',
      anchor: 'original quote',
      gist: 'Summary line',
      bullets: ['point 1', 'point 2'],
    });
    assert.ok(full.includes('## Section A'), 'heading');
    assert.ok(full.includes('> original quote'), 'anchor blockquote');
    assert.ok(full.includes('Summary line'), 'gist');
    assert.ok(full.includes('- point 1'), 'bullet 1');
    assert.ok(full.includes('- point 2'), 'bullet 2');

    const noAnchor = md.cardToMarkdown({ title: 'B', anchor: '', gist: 'G', bullets: [] });
    assert.ok(!noAnchor.includes('> '), 'no blockquote when anchor is empty');
    assert.ok(noAnchor.includes('## B'), 'heading present');
    assert.ok(noAnchor.includes('G'), 'gist present');

    const noBullets = md.cardToMarkdown({ title: 'C', anchor: '', gist: 'G', bullets: [] });
    assert.ok(!noBullets.includes('- '), 'no bullet markers for empty array');

    const noGist = md.cardToMarkdown({ title: 'D', anchor: 'a', gist: '', bullets: ['b'] });
    assert.ok(noGist.includes('> a'), 'anchor present');
    assert.ok(noGist.includes('- b'), 'bullets present');

    const anchorWhitespace = md.cardToMarkdown({
      title: 'E',
      anchor: '  spaces \n tabs \t here  ',
      gist: '',
      bullets: [],
    });
    assert.ok(anchorWhitespace.includes('> spaces tabs here'), 'anchor whitespace normalized');

    // ── cardToPlain ──
    const plain = md.cardToPlain({
      title: 'Section A',
      anchor: 'ignored in plain',
      gist: 'Summary',
      bullets: ['one', 'two'],
    });
    assert.ok(plain.includes('Section A'), 'title in plain');
    assert.ok(plain.includes('Summary'), 'gist in plain');
    assert.ok(plain.includes('• one'), 'bullet with dot');
    assert.ok(!plain.includes('ignored'), 'anchor not in plain text');

    const plainNoGist = md.cardToPlain({ title: 'T', anchor: '', gist: '', bullets: ['b'] });
    assert.ok(plainNoGist.includes('T'), 'title');
    assert.ok(plainNoGist.includes('• b'), 'bullet');
    assert.ok(!plainNoGist.includes('\n\n'), 'no double newline from empty gist');

    const plainNoBullets = md.cardToPlain({ title: 'T', anchor: '', gist: 'G', bullets: [] });
    assert.strictEqual(plainNoBullets, 'T\nG', 'just title and gist');

    const plainMinimal = md.cardToPlain({ title: 'T', anchor: '', gist: '', bullets: [] });
    assert.strictEqual(plainMinimal, 'T', 'title only when gist and bullets empty');

    // ── cardsToMarkdown ──
    const multi = md.cardsToMarkdown('My Title', [
      { title: 'A', anchor: 'q', gist: 'g', bullets: ['b'] },
      { title: 'B', anchor: '', gist: 'g2', bullets: [] },
    ]);
    assert.ok(multi.includes('# My Title'), 'top-level heading');
    assert.ok(multi.includes('## A'), 'first card');
    assert.ok(multi.includes('## B'), 'second card');

    const emptyTitle = md.cardsToMarkdown('', []);
    assert.strictEqual(emptyTitle, '# 对照笔记', 'empty title uses default');

    const nullCards = md.cardsToMarkdown('T', null);
    assert.strictEqual(nullCards, '# T', 'null cards array gives title only');

    const emptyCards = md.cardsToMarkdown('T', []);
    assert.strictEqual(emptyCards, '# T', 'empty cards array gives title only');

    console.log('direct markdown tests passed');
  } finally {
    cleanup();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
