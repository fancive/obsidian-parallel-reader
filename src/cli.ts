'use strict';

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { type GenerationJob, GenerationJobCancelledError } from './generation-job-manager';
import { parseCardsJson } from './schema';
import type { PluginSettings, RawCard } from './types';

/* Obsidian launched from GUI doesn't inherit shell PATH. */
export function resolveCliPath(name: string, override: string): string {
  if (override?.trim()) return override.trim();
  const home = os.homedir();
  const isWin = process.platform === 'win32';
  const exts = isWin ? ['.cmd', '.exe', ''] : [''];

  const dirs: string[] = isWin
    ? [
        path.join(home, 'AppData', 'Roaming', 'npm'),
        path.join(home, 'AppData', 'Local', 'Programs', 'claude-code'),
        path.join(home, 'AppData', 'Local', 'Programs', 'codex'),
        path.join(home, '.claude', 'local'),
        path.join(home, '.codex', 'bin'),
        path.join(home, '.bun', 'bin'),
        path.join(home, 'scoop', 'shims'),
        'C:\\Program Files\\nodejs',
      ]
    : [
        path.join(home, 'bin'),
        path.join(home, '.local', 'bin'),
        path.join(home, '.claude', 'local'),
        path.join(home, '.codex', 'bin'),
        path.join(home, '.bun', 'bin'),
        path.join(home, '.npm-global', 'bin'),
        path.join(home, '.cargo', 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
      ];

  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try {
        if (fs.existsSync(p)) return p;
      } catch (_) {
        // Ignore unreadable candidate paths and keep searching.
      }
    }
  }
  return name;
}

export function runCli(
  cmd: string,
  args: string[],
  stdinText: string,
  timeoutMs: number,
  job?: GenerationJob,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(err);
    };
    const succeed = (value: { stdout: string; stderr: string }) => {
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
          ]
            .filter(Boolean)
            .join(':'),
        },
      });
    } catch (e: unknown) {
      return reject(new Error(`Failed to start ${cmd}: ${(e as Error).message}`));
    }

    let stdout = '';
    let stderr = '';
    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (_) {
        /* ignore */
      }
      fail(new Error(`CLI timed out (${timeoutMs}ms)`));
    }, timeoutMs);
    if (job) {
      job.onCancel(() => {
        try {
          child.kill('SIGKILL');
        } catch (_) {
          /* ignore */
        }
        fail(new GenerationJobCancelledError(job.key));
      });
    }

    child.stdout!.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr!.on('data', (d) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (e) => {
      fail(new Error(`CLI startup error: ${e.message}. Try setting an absolute CLI path.`));
    });
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        return fail(new Error(`CLI exited with code ${code}\nstderr:\n${stderr.slice(0, 1000)}`));
      }
      succeed({ stdout, stderr });
    });

    if (stdinText) {
      try {
        child.stdin!.write(stdinText);
        child.stdin!.end();
      } catch (_e) {
        // Child may have exited before stdin was written.
      }
    } else {
      try {
        child.stdin!.end();
      } catch (_) {
        /* ignore */
      }
    }
  });
}

export async function summarizeViaClaudeCode(
  system: string,
  user: string,
  settings: PluginSettings,
  job?: GenerationJob,
): Promise<RawCard[]> {
  const cmd = resolveCliPath('claude', settings.cliPath);
  const args = [
    '-p',
    '--output-format',
    'json',
    '--append-system-prompt',
    system,
    '--disallowed-tools',
    'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,TodoWrite,Task',
  ];
  const { stdout } = await runCli(cmd, args, user, settings.cliTimeoutMs, job);

  // --output-format json produces a JSON array of event objects.
  // Find the "result" entry and extract its .result text field.
  let resultText = '';
  try {
    const events = JSON.parse(stdout);
    if (Array.isArray(events)) {
      const resultEvent = events.find((e: Record<string, unknown>) => e.type === 'result');
      if (resultEvent && typeof resultEvent.result === 'string') {
        resultText = resultEvent.result;
      }
    } else if (events && typeof events === 'object') {
      // Older CLI versions return a single object
      resultText = events.result || events.content || '';
    }
  } catch (_) {
    throw new Error('claude CLI returned unexpected output:\n' + stdout.slice(0, 500));
  }

  if (!resultText) {
    throw new Error('claude CLI returned no result. Output:\n' + stdout.slice(0, 500));
  }

  return parseCardsJson(resultText, settings);
}

export async function summarizeViaCodex(
  system: string,
  user: string,
  settings: PluginSettings,
  job?: GenerationJob,
): Promise<RawCard[]> {
  const cmd = resolveCliPath('codex', settings.cliPath);
  const combined = `<<SYSTEM>>\n${system}\n<<USER>>\n${user}\n\nOutput JSON directly with no explanation.`;
  const args = ['exec', '--skip-git-repo-check', '-'];
  const { stdout } = await runCli(cmd, args, combined, settings.cliTimeoutMs, job);
  return parseCardsJson(stdout, settings);
}
