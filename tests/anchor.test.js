const { assert, t } = require('./test-setup');

assert.strictEqual(t.findLineForAnchor('', 'hello'), -1, 'empty content returns -1');
assert.strictEqual(t.findLineForAnchor('hello world', ''), -1, 'empty anchor returns -1');
assert.strictEqual(t.findLineForAnchor('hello world', 'hello world'), 0, 'exact full match on line 0');
assert.strictEqual(t.findLineForAnchor('line0\nline1\nhello', 'hello'), 2, 'exact match on line 2');
assert.strictEqual(t.findLineForAnchor('line0\nline1\nhello world', '  hello world  '), 2, 'trimmed match');
assert.strictEqual(
  t.findLineForAnchor('intro\nThe quick brown fox jumps over the lazy dog\nend', 'The quick brown fox jumps'),
  1,
  'prefix match at 60-char threshold',
);
assert.strictEqual(
  t.findLineForAnchor('a\nb\nc\nd\ne\nAlpha   beta\nGamma\tDelta\nlast', 'Alpha beta Gamma Delta'),
  5,
  'normalized whitespace match returns correct line',
);
assert.strictEqual(t.findLineForAnchor('hello\nworld', 'zzz_not_found'), -1, 'unmatched anchor returns -1');
assert.strictEqual(
  t.findLineForAnchor('first line\nsecond with 日本語 text\nthird', '日本語'),
  1,
  'unicode anchor match',
);

// ── perf: precomputed line-offset index must yield identical results ──
const doc = 'l0\nl1\nl2 needle here\nl3\n\nl5 tail';
const offsets = t.buildLineOffsets(doc);
assert.deepStrictEqual(offsets, [0, 3, 6, 21, 24, 25], 'buildLineOffsets marks each line start');
assert.strictEqual(
  t.findLineForAnchor(doc, 'needle here', offsets),
  t.findLineForAnchor(doc, 'needle here'),
  'threaded offsets match self-computed result (exact path)',
);
assert.strictEqual(t.findLineForAnchor(doc, 'tail', offsets), 5, 'threaded offsets resolve trailing line');
// Non-ASCII whitespace (NBSP  ) must still normalize like /\s/ did.
assert.strictEqual(
  t.findLineForAnchor('x\ny\nAlpha  beta gamma\nz', 'Alpha beta gamma'),
  2,
  'NBSP collapses to single space in normalized fallback match',
);
assert.strictEqual(t.buildLineOffsets('')[0], 0, 'empty content still has line 0');

console.log('anchor tests passed');
