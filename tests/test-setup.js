const assert = require('assert');
const { EventEmitter } = require('events');

// Installs the resolve hooks (bare `obsidian` -> tests/obsidian-mock.mjs, and `.ts`
// on extensionless relative specifiers) and polyfills `activeWindow`. Must come
// before any `.ts` module is loaded.
require('./ts-loader');

const { getRequestUrlMock, setRequestUrlMock } = require('./obsidian-mock.mjs');

// The whole source graph, loaded straight from TypeScript. `require()` of an ES
// module is synchronous in Node >= 22.12, so this stays a plain CJS export and no
// test file needs to await the harness.
const t = require('../src/test-exports.ts');

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
