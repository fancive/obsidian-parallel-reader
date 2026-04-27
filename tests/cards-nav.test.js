const { assert, t } = require('./test-setup');

// ── cards.ts ──

const cards = [{ title: 'A' }, { title: 'B' }, { title: 'C' }];
assert.deepStrictEqual(t.removeCardAt(cards, 0), [{ title: 'B' }, { title: 'C' }], 'remove first');
assert.deepStrictEqual(t.removeCardAt(cards, 2), [{ title: 'A' }, { title: 'B' }], 'remove last');
assert.strictEqual(t.removeCardAt(cards, 0).length, 2, 'returns new array');
assert.strictEqual(cards.length, 3, 'original not mutated');
assert.deepStrictEqual(t.removeCardAt([], 0), [], 'empty array');
assert.deepStrictEqual(t.removeCardAt(cards, -1).length, 3, 'negative index no-op');
assert.deepStrictEqual(t.removeCardAt(cards, 5).length, 3, 'out of range no-op');

assert.strictEqual(t.activeIndexAfterCardDelete(0, 3, 0), 0, 'delete first active -> stays 0');
assert.strictEqual(t.activeIndexAfterCardDelete(2, 3, 2), 1, 'delete last active -> previous');
assert.strictEqual(t.activeIndexAfterCardDelete(0, 1, 0), -1, 'single card delete -> -1');
assert.strictEqual(t.activeIndexAfterCardDelete(1, 5, 3), 2, 'delete before active -> shift left');
assert.strictEqual(t.activeIndexAfterCardDelete(3, 5, 1), 1, 'delete after active -> no change');

const updated = t.updateCardAt(cards, 1, { title: 'B2', gist: 'new gist' });
assert.strictEqual(updated[1].title, 'B2');
assert.strictEqual(updated[1].gist, 'new gist');
assert.strictEqual(updated[0].title, 'A', 'other cards unchanged');
assert.strictEqual(cards[1].title, 'B', 'original not mutated');

// ── navigation.ts ──

assert.strictEqual(t.nextCardIndex(-1, 5, 1), 0, 'from none forward -> first');
assert.strictEqual(t.nextCardIndex(-1, 5, -1), 4, 'from none backward -> last');
assert.strictEqual(t.nextCardIndex(0, 5, 1), 1, 'step forward');
assert.strictEqual(t.nextCardIndex(4, 5, 1), 4, 'clamp at end');
assert.strictEqual(t.nextCardIndex(0, 5, -1), 0, 'clamp at start');
assert.strictEqual(t.nextCardIndex(2, 5, -1), 1, 'step backward');
assert.strictEqual(t.nextCardIndex(0, 0, 1), -1, 'empty list');
assert.strictEqual(t.nextCardIndex(0, -1, 1), -1, 'negative count');

assert.strictEqual(t.activeSectionLine([{ startLine: 10 }], 0), 10);
assert.strictEqual(t.activeSectionLine([{ startLine: -1 }], 0), -1, 'negative startLine');
assert.strictEqual(t.activeSectionLine([], 0), -1, 'empty sections');
assert.strictEqual(t.activeSectionLine([{ startLine: 5 }], -1), -1, 'negative index');
assert.strictEqual(t.activeSectionLine([{ startLine: 5 }], 1), -1, 'out of range index');
assert.strictEqual(t.activeSectionLine(null, 0), -1, 'null sections');

console.log('cards-nav tests passed');
