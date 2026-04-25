'use strict';

import { spawn } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs';
import type { PluginSettings, RawCard } from './types';
import { GenerationJob, GenerationJobCancelledError } from './generation-job-manager';
import { parseCardsJson } from './schema';

/* Obsidian launched from GUI doesn't inherit shell PATH. */
export function resolveCliPath(name: string, override: string): string {
  if (override && override.trim()) return override.trim();
  const home = os.homedir();
  const candidates = [
    path.join(home, 'bin', name),
    path.join(home, '.local/bin', name),
    path.join(home, '.claude/local', name),
    path.join(home, '.codex/bin', name),
    path.join(home, '.bun/bin', name),
    path.join(home, '.npm-global/bin', name),
    path.join(home, '.cargo/bin', name),
    '/opt/homebrew/bin/' + name,
    '/usr/local/bin/' + name,
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {
      // Ignore unreadable candidate paths and keep searching.
    }
  }
  return name;
}

export function runCli(cmd: string, args: string[], stdinText: string, timeoutMs: number, job?: GenerationJob): Promise<{ stdout: string; stderr: string }> {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    let child;
    let settled = false;
    let timer;
    const fail = err => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(err);
    };
    const succeed = value => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    try {
      child = spawn(cmd, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PATH: [
            process.env.PATH || '',
            '/usr/local/bin',
            '/opt/homebrew/bin',
            path.join(os.homedir(), '.local/bin'),
            path.join(os.homedir(), '.claude/local'),
          ].filter(Boolean).join(':'),
        },
      });
    } catch (e) {
      return reject(new Error(`Failed to start ${cmd}: ${e.message}`));
    }

    let stdout = '';
    let stderr = '';
    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
      fail(new Error(`CLI timed out (${timeoutMs}ms)`));
    }, timeoutMs);
    if (job) {
      job.onCancel(() => {
        try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
        fail(new GenerationJobCancelledError(job.key));
      });
    }

    child.stdout.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });
    child.on('error', e => {
      fail(new Error(`CLI startup error: ${e.message}. Try setting an absolute CLI path.`));
    });
    child.on('close', code => {
      if (settled) return;
      if (code !== 0) {
        return fail(new Error(`CLI exited with code ${code}\nstderr:\n${stderr.slice(0, 1000)}`));
      }
      succeed({ stdout, stderr });
    });

    if (stdinText) {
      try {
        child.stdin.write(stdinText);
        child.stdin.end();
      } catch (e) {
        // Child may have exited before stdin was written.
      }
    } else {
      try { child.stdin.end(); } catch (_) { /* ignore */ }
    }
  });
}

export async function summarizeViaClaudeCode(system: string, user: string, settings: PluginSettings, job?: GenerationJob): Promise<RawCard[]> {
  const cmd = resolveCliPath('claude', settings.cliPath);
  const args = [
    '-p',
    '--output-format', 'json',
    '--append-system-prompt', system,
    '--disallowed-tools', 'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,TodoWrite,Task',
  ];
  if (settings.model) {
    args.push('--model', settings.model);
  }
  const { stdout } = await runCli(cmd, args, user, settings.cliTimeoutMs, job);

  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch (e) {
    throw new Error('claude CLI returned a non-JSON envelope:\n' + stdout.slice(0, 500));
  }
  const resultText = envelope.result || envelope.content || '';
  return parseCardsJson(resultText, settings);
}

export async function summarizeViaCodex(system: string, user: string, settings: PluginSettings, job?: GenerationJob): Promise<RawCard[]> {
  const cmd = resolveCliPath('codex', settings.cliPath);
  const combined = `<<SYSTEM>>\n${system}\n<<USER>>\n${user}\n\nOutput JSON directly with no explanation.`;
  const args = ['exec', '--skip-git-repo-check', '-'];
  const { stdout } = await runCli(cmd, args, combined, settings.cliTimeoutMs, job);
  return parseCardsJson(stdout, settings);
}
