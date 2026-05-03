const assert = require('assert');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

// Polyfill Obsidian's `activeWindow` global for Node test runtime.
if (typeof globalThis.activeWindow === 'undefined') {
  globalThis.activeWindow = globalThis;
}

// Load obsidian mock first — hooks Module._load so that require('obsidian')
// returns the mock for both us and the esbuild-bundled test-exports module.
const { getRequestUrlMock, setRequestUrlMock } = require('./obsidian-mock');

// Bundle test-exports.ts synchronously with obsidian marked as external.
// The bundled code will require('obsidian') at runtime, hitting our mock.
const repoRoot = path.join(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-reader-test-setup-'));
const outfile = path.join(tempDir, 'test-exports.cjs');

esbuild.buildSync({
  entryPoints: [path.join(repoRoot, 'src/test-exports.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
  external: ['obsidian'],
});

const t = require(outfile);

// Clean up temp bundle on process exit.
process.on('exit', () => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (_) {
    // Best-effort cleanup.
  }
});

function openAiCardsResponse(cards) {
  const json = {
    choices: [
      {
        message: {
          content: JSON.stringify({ cards }),
        },
      },
    ],
  };
  return { status: 200, json, text: JSON.stringify(json) };
}

const baseSettings = {
  backend: 'api',
  apiProvider: 'openai',
  apiFormat: 'openai-chat',
  apiBaseUrl: 'https://api.openai.com/v1',
  apiAuthType: 'bearer',
  apiKey: 'test-key',
  apiMaxTokens: 4096,
  model: 'openai/gpt-5.1',
};

module.exports = {
  assert,
  EventEmitter,
  t,
  baseSettings,
  openAiCardsResponse,
  getRequestUrlMock,
  setRequestUrlMock,
};
