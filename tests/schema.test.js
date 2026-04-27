const { assert, t } = require('./test-setup');

const { extractJson, normalizeCardsPayload, repairTruncatedCardsJson, collectJsonObjectCandidates } = t;

// ── extractJson ──

assert.strictEqual(extractJson(''), '', 'empty text returns empty');
assert.strictEqual(extractJson('{"a":1}'), '{"a":1}', 'already-valid JSON returned as-is');
assert.strictEqual(
  JSON.parse(extractJson('prefix {"cards":[]} suffix')).cards.length,
  0, 'extracts JSON from surrounding text'
);
assert.strictEqual(
  JSON.parse(extractJson('```json\n{"cards":[]}\n```')).cards.length,
  0, 'extracts JSON from fenced code block'
);
assert.strictEqual(
  JSON.parse(extractJson('text {"a":1} and {"cards":[{"title":"T"}]} end')).cards[0].title,
  'T', 'picks the largest valid JSON object'
);
assert.strictEqual(extractJson('not json at all'), 'not json at all', 'non-JSON text returned as-is');

const nestedBraces = '{"cards":[{"title":"test {with} braces","anchor":"a","gist":"g","bullets":[]}]}';
assert.deepStrictEqual(JSON.parse(extractJson(nestedBraces)).cards[0].title, 'test {with} braces');

// ── repairTruncatedCardsJson ──

assert.strictEqual(repairTruncatedCardsJson('not json'), null, 'non-cards text returns null');
assert.strictEqual(repairTruncatedCardsJson(''), null, 'empty string returns null');
assert.strictEqual(repairTruncatedCardsJson('{"cards":['), null, 'no complete cards returns null');

const truncJson = '{"cards":[{"title":"A","anchor":"a","gist":"g","bullets":["b"]},{"title":"B","anchor":"x","gist":"trunc';
const repaired = repairTruncatedCardsJson(truncJson);
assert.ok(repaired, 'truncated JSON is repaired');
const repairedParsed = JSON.parse(repaired);
assert.strictEqual(repairedParsed.cards.length, 1, 'only complete card is kept');
assert.strictEqual(repairedParsed.cards[0].title, 'A', 'salvaged card has correct title');

const twoComplete = '{"cards":[{"title":"A","anchor":"a","gist":"g","bullets":["b"]},{"title":"B","anchor":"a2","gist":"g2","bullets":["c"]},{"title":"C","anch';
const repairedTwo = JSON.parse(repairTruncatedCardsJson(twoComplete));
assert.strictEqual(repairedTwo.cards.length, 2, 'two complete cards salvaged from three');

const salvagedCards = normalizeCardsPayload(JSON.parse(repairTruncatedCardsJson(truncJson)));
assert.strictEqual(salvagedCards.length, 1, 'repair + normalize produces valid cards');
assert.strictEqual(salvagedCards[0].title, 'A', 'salvaged card has correct fields');

const spaced = '{  "cards" : [  {"title":"A","anchor":"a","gist":"g","bullets":[]},{"title":"B","anch';
const repairedSpaced = repairTruncatedCardsJson(spaced);
assert.ok(repairedSpaced, 'repair handles whitespace in cards pattern');
assert.strictEqual(JSON.parse(repairedSpaced).cards.length, 1, 'repair with whitespace keeps complete card');

const escapedQuotes = '{"cards":[{"title":"A \\"quoted\\"","anchor":"a","gist":"g","bullets":["line \\"1\\""]},{"title":"B","anch';
const repairedEscaped = repairTruncatedCardsJson(escapedQuotes);
assert.ok(repairedEscaped, 'repair handles escaped quotes in values');
assert.strictEqual(JSON.parse(repairedEscaped).cards[0].title, 'A "quoted"', 'escaped quotes preserved');

const bracesInStrings = '{"cards":[{"title":"func() { return }","anchor":"a","gist":"{obj}","bullets":[]},{"incomp';
const repairedBraces = repairTruncatedCardsJson(bracesInStrings);
assert.ok(repairedBraces, 'repair handles braces inside strings');
assert.strictEqual(JSON.parse(repairedBraces).cards[0].title, 'func() { return }', 'braces in string preserved');

assert.strictEqual(repairTruncatedCardsJson('{"cards":[{"title":"incomp'), null, 'all truncated cards returns null');
assert.strictEqual(repairTruncatedCardsJson('{"cards":[]'), null, 'empty truncated array returns null');

// ── collectJsonObjectCandidates ──

assert.deepStrictEqual(collectJsonObjectCandidates(''), [], 'empty string gives no candidates');
assert.deepStrictEqual(collectJsonObjectCandidates('no braces'), [], 'no braces gives no candidates');
assert.deepStrictEqual(collectJsonObjectCandidates('{"a":1}'), ['{"a":1}'], 'single object extracted');
assert.deepStrictEqual(collectJsonObjectCandidates('{"a":1} {"b":2}'), ['{"a":1}', '{"b":2}'], 'multiple objects extracted');
assert.deepStrictEqual(collectJsonObjectCandidates('{"a":{"b":1}}'), ['{"a":{"b":1}}'], 'nested objects extracted as one');
assert.deepStrictEqual(collectJsonObjectCandidates('{"a":"{}"}'), ['{"a":"{}"}'], 'braces in strings handled correctly');
assert.deepStrictEqual(collectJsonObjectCandidates('{unclosed'), [], 'unclosed brace gives no candidates');

// ── normalizeCardsPayload ──

assert.deepStrictEqual(normalizeCardsPayload(null), [], 'null payload returns empty array');
assert.deepStrictEqual(normalizeCardsPayload({}), [], 'empty object returns empty array');
assert.deepStrictEqual(normalizeCardsPayload({ cards: [null, undefined, 42, 'str'] }), [], 'non-object items filtered');
assert.deepStrictEqual(
  normalizeCardsPayload({ cards: [{ title: 'T', anchor: 'A', gist: 'G', bullets: ['B'] }] }),
  [{ title: 'T', anchor: 'A', gist: 'G', bullets: ['B'] }],
  'valid card passes through'
);
assert.deepStrictEqual(
  normalizeCardsPayload({ cards: [{ title: 123, gist: null, bullets: [1, 'valid', null] }] }),
  [{ title: '(无标题)', anchor: '', gist: '', bullets: ['valid'] }],
  'non-string fields get defaults, non-string bullets filtered'
);

console.log('schema tests passed');
