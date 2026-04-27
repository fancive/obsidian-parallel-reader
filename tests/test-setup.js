const assert = require('assert');
const { EventEmitter } = require('events');
const { getRequestUrlMock, setRequestUrlMock } = require('./obsidian-mock');

const t = require('../main.js').__test;

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
