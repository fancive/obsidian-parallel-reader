'use strict';

import { requestUrl } from 'obsidian';
import { resolveCliPath, runCli, summarizeViaClaudeCode, summarizeViaCodex } from './cli';
import type { RequestUrlFunction } from './provider-request';
import { testApiBackend } from './providers';
import { normalizeCliTimeoutMs } from './settings';
import type { PluginSettings } from './types';

const CLI_TEST_SYSTEM =
  'Return only valid JSON with exactly one card: {"cards":[{"title":"CLI smoke","anchor":"parallel reader smoke anchor","gist":"ok","bullets":["ok"]}]}';
const CLI_TEST_USER = 'parallel reader smoke anchor';
const CLI_TEST_TIMEOUT_MS = 60000;

type SpawnImpl = Parameters<typeof runCli>[5];

interface BackendTestDeps {
  requestUrlImpl?: RequestUrlFunction;
  spawnImpl?: SpawnImpl;
}

function cliSmokeSettings(settings: PluginSettings): PluginSettings {
  return {
    ...settings,
    cliTimeoutMs: Math.min(normalizeCliTimeoutMs(settings.cliTimeoutMs), CLI_TEST_TIMEOUT_MS),
    minCards: 1,
    maxCards: 1,
    maxDocChars: 1000,
  };
}

export async function testBackend(settings: PluginSettings, deps: BackendTestDeps = {}): Promise<string> {
  if (settings.backend === 'claude-code') {
    const cmd = resolveCliPath('claude', settings.cliPath);
    const version = await runCli(cmd, ['--version'], '', 10000, undefined, deps.spawnImpl);
    const cards = await summarizeViaClaudeCode(
      CLI_TEST_SYSTEM,
      CLI_TEST_USER,
      cliSmokeSettings(settings),
      undefined,
      deps.spawnImpl,
    );
    return `claude @ ${cmd}\n${version.stdout.trim()}\nsmoke: ${cards.length} card`;
  }

  if (settings.backend === 'codex') {
    const cmd = resolveCliPath('codex', settings.cliPath);
    const version = await runCli(cmd, ['--version'], '', 10000, undefined, deps.spawnImpl);
    const cards = await summarizeViaCodex(
      CLI_TEST_SYSTEM,
      CLI_TEST_USER,
      cliSmokeSettings(settings),
      undefined,
      deps.spawnImpl,
    );
    return `codex @ ${cmd}\n${version.stdout.trim()}\nsmoke: ${cards.length} card`;
  }

  return testApiBackend(deps.requestUrlImpl || requestUrl, settings);
}
