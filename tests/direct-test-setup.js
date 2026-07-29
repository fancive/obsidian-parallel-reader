const assert = require('assert');
const path = require('path');

// Installs the resolve hooks (bare `obsidian` -> tests/obsidian-mock.mjs, and `.ts`
// on extensionless relative specifiers) and polyfills `activeWindow`. Must come
// before any `.ts` module is loaded.
require('./ts-loader');

const { setRequestUrlMock } = require('./obsidian-mock.mjs');

const repoRoot = path.join(__dirname, '..');

// Direct-module tests must not reach the HTTP boundary implicitly — the modules under
// test all take a `RequestUrlFunction` explicitly. The previous harness enforced that by
// bundling these modules against an `obsidian` stub whose requestUrl threw; now that
// every test shares one mock, re-arm the same guarantee here.
setRequestUrlMock(async () => {
  throw new Error('requestUrl not available in direct module tests');
});

/**
 * Loads a single source module by repo-relative path (e.g. `src/cache.ts`).
 *
 * Unlike the shared `test-setup` harness this does NOT pull in the whole
 * `src/test-exports.ts` barrel, so a "direct" test still only drags in its own
 * module's import graph. It used to esbuild-bundle that graph into a temp file;
 * it now hands the path straight to Node, which strips the types itself.
 *
 * Stays async so the existing `await requireSourceModule(...)` call sites keep
 * working unchanged.
 */
async function requireSourceModule(relativePath) {
  return require(path.join(repoRoot, relativePath));
}

/**
 * No-op retained so the `try { … } finally { cleanup(); }` blocks in the
 * direct-*.test.js files keep working: there is no longer a temp bundle
 * directory to remove.
 */
function cleanup() {}

module.exports = { assert, requireSourceModule, cleanup };
