const assert = require('assert');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Polyfill Obsidian's `activeWindow` global for Node test runtime.
if (typeof globalThis.activeWindow === 'undefined') {
  globalThis.activeWindow = globalThis;
}

const repoRoot = path.join(__dirname, '..');
// Under c8, bundles must live inside the repo so c8 processes their coverage
// (it ignores scripts outside cwd before source-map remap). Otherwise /tmp.
const bundleParent = process.env.NODE_V8_COVERAGE
  ? fs.mkdirSync(path.join(repoRoot, '.test-bundles'), { recursive: true }) || path.join(repoRoot, '.test-bundles')
  : os.tmpdir();
const tempDir = fs.mkdtempSync(path.join(bundleParent, 'parallel-reader-tests-'));

async function requireBundledModule(relativePath) {
  const entry = path.join(repoRoot, relativePath);
  const outfile = path.join(tempDir, relativePath.replace(/[/.]/g, '_') + '.cjs');
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    sourcemap: 'inline',
    sourcesContent: true,
    sourceRoot: repoRoot,
    plugins: [
      {
        name: 'obsidian-stub',
        setup(build) {
          build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian-stub', namespace: 'stub' }));
          build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
            contents:
              'module.exports = { requestUrl: async () => { throw new Error("requestUrl not available in direct module tests"); } };',
            loader: 'js',
          }));
        },
      },
    ],
  });
  require('./coverage-sourcemap').fixInlineSourceMap(outfile, repoRoot);
  return require(outfile);
}

function cleanup() {
  // Skipped under c8 coverage: c8 reads V8 coverage at exit and needs the
  // bundled file (with its inline source map) still on disk to remap to src/.
  if (process.env.NODE_V8_COVERAGE) return;
  fs.rmSync(tempDir, { recursive: true, force: true });
}

module.exports = { assert, requireBundledModule, cleanup, repoRoot, tempDir };
