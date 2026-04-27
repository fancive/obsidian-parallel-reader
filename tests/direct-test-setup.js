const assert = require('assert');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-reader-tests-'));

async function requireBundledModule(relativePath) {
  const entry = path.join(repoRoot, relativePath);
  const outfile = path.join(tempDir, relativePath.replace(/[/.]/g, '_') + '.cjs');
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
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
  return require(outfile);
}

function cleanup() {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

module.exports = { assert, requireBundledModule, cleanup, repoRoot, tempDir };
