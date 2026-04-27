const { assert, t } = require('./test-setup');

assert.strictEqual(t.findLineForAnchor('', 'hello'), -1, 'empty content returns -1');
assert.strictEqual(t.findLineForAnchor('hello world', ''), -1, 'empty anchor returns -1');
assert.strictEqual(t.findLineForAnchor('hello world', 'hello world'), 0, 'exact full match on line 0');
assert.strictEqual(t.findLineForAnchor('line0\nline1\nhello', 'hello'), 2, 'exact match on line 2');
assert.strictEqual(t.findLineForAnchor('line0\nline1\nhello world', '  hello world  '), 2, 'trimmed match');
assert.strictEqual(
  t.findLineForAnchor('intro\nThe quick brown fox jumps over the lazy dog\nend', 'The quick brown fox jumps'),
  1, 'prefix match at 60-char threshold'
);
assert.strictEqual(
  t.findLineForAnchor('a\nb\nc\nd\ne\nAlpha   beta\nGamma\tDelta\nlast', 'Alpha beta Gamma Delta'),
  5, 'normalized whitespace match returns correct line'
);
assert.strictEqual(t.findLineForAnchor('hello\nworld', 'zzz_not_found'), -1, 'unmatched anchor returns -1');
assert.strictEqual(
  t.findLineForAnchor('first line\nsecond with 日本語 text\nthird', '日本語'),
  1, 'unicode anchor match'
);

console.log('anchor tests passed');
