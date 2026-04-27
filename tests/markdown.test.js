const { assert, t } = require('./test-setup');

const md = t.cardsToMarkdown('Test Title', [
  { title: 'Section 1', anchor: 'original quote', gist: 'Summary', bullets: ['point a', 'point b'] },
  { title: 'Section 2', gist: 'Gist only', bullets: [] },
]);
assert.ok(md.includes('# Test Title'), 'top-level heading');
assert.ok(md.includes('## Section 1'), 'card heading');
assert.ok(md.includes('> original quote'), 'anchor blockquote');
assert.ok(md.includes('Summary'), 'gist included');
assert.ok(md.includes('- point a'), 'bullet list');
assert.ok(md.includes('## Section 2'), 'second card');
assert.ok(!md.includes('> \n'), 'no empty blockquote for card without anchor');

assert.strictEqual(t.cardsToMarkdown('', []), '# 对照笔记', 'empty title uses default');

const plain = t.cardsToMarkdown('X', []);
assert.ok(plain.includes('# X'));

console.log('markdown tests passed');
