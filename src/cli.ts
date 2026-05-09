'use strict';

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { type GenerationJob, GenerationJobCancelledError } from './generation-job-manager';
import { translate } from './i18n';
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
      } catch {
        // Ignore unreadable candidate paths and keep searching.
      }
    }
  }
  return name;
}

export type CliFailureReason =
  | 'wall-timeout'
  | 'exit-nonzero'
  | 'streams-unavailable'
  | 'spawn-failure'
  | 'startup-error';

export interface CliErrorDetails {
  reason: CliFailureReason;
  cmd: string;
  pid: number | null;
  elapsedMs: number;
  /** ms since the last byte of stdout/stderr — useful to tell hung-mid-call from hung-from-start. */
  idleMs: number | null;
  stdoutBytes: number;
  stderrBytes: number;
  /** Already secret-redacted, capped to DIAG_STDERR_TAIL_CHARS. */
  stderrTail: string;
  /** Already secret-redacted, capped to DIAG_STDOUT_TAIL_CHARS. */
  stdoutTail: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timeoutMs: number;
}

export class CliProcessError extends Error {
  readonly name = 'CliProcessError';
  readonly details: CliErrorDetails;

  constructor(message: string, details: CliErrorDetails) {
    super(message);
    this.details = details;
  }
}

const DIAG_STDERR_TAIL_CHARS = 1500;
const DIAG_STDOUT_TAIL_CHARS = 1500;
const EMPTY_MCP_CONFIG = '{"mcpServers":{}}';

function tail(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(-max);
}

const REDACT = '[REDACTED]';
function redactSecrets(text: string): string {
  if (!text) return text;
  return text
    .replace(/\b(Bearer)\s+[\w.\-+/=]{6,}/gi, `$1 ${REDACT}`)
    .replace(/\b(x-api-key|x-goog-api-key|api[_-]?key|authorization)\s*[:=]\s*[\w.\-+/=]{6,}/gi, `$1: ${REDACT}`)
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})/g, REDACT);
}

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function claudeResultText(stdout: string): string {
  const events: Array<Record<string, unknown>> = [];
  try {
    const parsed = JSON.parse(stdout);
    if (Array.isArray(parsed)) {
      events.push(...(parsed.filter((e) => e && typeof e === 'object') as Array<Record<string, unknown>>));
    } else if (parsed && typeof parsed === 'object') {
      events.push(parsed as Record<string, unknown>);
    }
  } catch {
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') events.push(parsed as Record<string, unknown>);
      } catch {
        // Ignore non-JSON progress lines and keep scanning for result events.
      }
    }
  }

  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === 'result' && typeof event.result === 'string') return event.result;
  }
  const single = events[0];
  if (single && typeof single.result === 'string') return single.result;
  if (single && typeof single.content === 'string') return single.content;
  return '';
}

export function runCli(
  cmd: string,
  args: string[],
  stdinText: string,
  timeoutMs: number,
  job?: GenerationJob,
  spawnImpl: typeof spawn = spawn,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    let settled = false;
    let timer: number | null = null;
    const startedAt = Date.now();
    let lastActivityAt = startedAt;
    const clearTimers = () => {
      if (timer) {
        activeWindow.clearTimeout(timer);
        timer = null;
      }
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      console.warn('[parallel-reader] cli failed', {
        cmd,
        pid: child?.pid,
        elapsedMs: Date.now() - startedAt,
        error: err.message,
      });
      reject(err);
    };
    const succeed = (value: { stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      clearTimers();
      console.debug('[parallel-reader] cli ok', {
        cmd,
        pid: child?.pid,
        elapsedMs: Date.now() - startedAt,
        stdoutBytes: utf8ByteLength(value.stdout),
        stderrBytes: utf8ByteLength(value.stderr),
      });
      resolve(value);
    };
    try {
      child = spawnImpl(cmd, args, {
        // Lock cwd to the user's home dir. Inheriting Obsidian's cwd (often the Vault path)
        // can break Claude CLI's per-project memory writes — iCloud-synced Vault paths
        // contain characters like `~md~` that produce malformed `~/.claude/projects/...`
        // slugs and an immediate exit-1 with empty modelUsage. Home dir is stable and
        // writable; the LLM call itself is independent of cwd.
        cwd: os.homedir(),
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
      const message = `Failed to start ${cmd}: ${e instanceof Error ? e.message : String(e)}`;
      console.warn('[parallel-reader] cli spawn failed', { cmd, error: message });
      return reject(
        new CliProcessError(message, {
          reason: 'spawn-failure',
          cmd,
          pid: null,
          elapsedMs: Date.now() - startedAt,
          idleMs: null,
          stdoutBytes: 0,
          stderrBytes: 0,
          stdoutTail: '',
          stderrTail: '',
          exitCode: null,
          signal: null,
          timeoutMs,
        }),
      );
    }

    console.debug('[parallel-reader] cli spawn', {
      cmd,
      argCount: args.length,
      pid: child?.pid,
      timeoutMs,
    });

    let stdout = '';
    let stderr = '';

    const collectDetails = (
      reason: CliFailureReason,
      idleMs: number,
      extras: { exitCode?: number | null; signal?: NodeJS.Signals | null } = {},
    ): CliErrorDetails => ({
      reason,
      cmd,
      pid: child?.pid ?? null,
      elapsedMs: Date.now() - startedAt,
      idleMs,
      stdoutBytes: utf8ByteLength(stdout),
      stderrBytes: utf8ByteLength(stderr),
      stdoutTail: redactSecrets(tail(stdout, DIAG_STDOUT_TAIL_CHARS)),
      stderrTail: redactSecrets(tail(stderr, DIAG_STDERR_TAIL_CHARS)),
      exitCode: extras.exitCode ?? null,
      signal: extras.signal ?? null,
      timeoutMs,
    });

    const buildDiagSuffix = (details: CliErrorDetails): string => {
      let suffix =
        ` [pid=${details.pid ?? 'unknown'} elapsed=${details.elapsedMs}ms idle=${details.idleMs ?? 0}ms ` +
        `stdout=${details.stdoutBytes}B stderr=${details.stderrBytes}B]`;
      if (details.stderrTail) suffix += `\n--- stderr tail ---\n${details.stderrTail}`;
      if (details.stdoutTail) suffix += `\n--- stdout tail ---\n${details.stdoutTail}`;
      return suffix;
    };

    timer = activeWindow.setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (e: unknown) {
        console.warn('[parallel-reader] failed to kill timed-out CLI process', e);
      }
      const idleMs = Date.now() - lastActivityAt;
      const details = collectDetails('wall-timeout', idleMs, { signal: 'SIGKILL' });
      fail(new CliProcessError(`CLI timed out (${timeoutMs}ms)${buildDiagSuffix(details)}`, details));
    }, timeoutMs);

    if (job) {
      job.onCancel(() => {
        try {
          child.kill('SIGKILL');
        } catch (e: unknown) {
          console.warn('[parallel-reader] failed to kill cancelled CLI process', e);
        }
        fail(new GenerationJobCancelledError(job.key));
      });
    }

    if (!child.stdout || !child.stderr || !child.stdin) {
      fail(new CliProcessError('CLI process streams are unavailable', collectDetails('streams-unavailable', 0)));
      return;
    }

    const childStdout = child.stdout;
    const childStderr = child.stderr;
    const childStdin = child.stdin;

    const noteActivity = () => {
      if (settled) return;
      lastActivityAt = Date.now();
    };

    childStdout.on('data', (d) => {
      stdout += d.toString('utf8');
      noteActivity();
    });
    childStderr.on('data', (d) => {
      stderr += d.toString('utf8');
      noteActivity();
    });
    child.on('error', (e) => {
      const idleMs = Date.now() - lastActivityAt;
      fail(
        new CliProcessError(
          `CLI startup error: ${e.message}. Try setting an absolute CLI path.`,
          collectDetails('startup-error', idleMs),
        ),
      );
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        const idleMs = Date.now() - lastActivityAt;
        const details = collectDetails('exit-nonzero', idleMs, { exitCode: code, signal });
        // Some CLIs (notably `claude --output-format json`) emit error events to stdout
        // instead of stderr. Always include both tails so the failure mode is debuggable
        // even when stderr is empty.
        let suffix = '';
        if (details.stderrTail) suffix += `\nstderr:\n${details.stderrTail}`;
        if (details.stdoutTail) suffix += `\nstdout:\n${details.stdoutTail}`;
        if (!suffix) suffix = '\n(no output on either stream)';
        return fail(new CliProcessError(`CLI exited with code ${code} (signal=${signal ?? 'none'})${suffix}`, details));
      }
      succeed({ stdout, stderr });
    });

    if (stdinText) {
      try {
        childStdin.write(stdinText);
        childStdin.end();
      } catch {
        // Child may have exited before stdin was written.
      }
    } else {
      try {
        childStdin.end();
      } catch (e: unknown) {
        console.warn('[parallel-reader] failed to close CLI stdin', e);
      }
    }
  });
}

export async function summarizeViaClaudeCode(
  system: string,
  user: string,
  settings: PluginSettings,
  job?: GenerationJob,
  spawnImpl?: typeof spawn,
): Promise<RawCard[]> {
  const cmd = resolveCliPath('claude', settings.cliPath);
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--append-system-prompt',
    system,
    '--tools',
    '',
    '--disallowed-tools',
    'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,TodoWrite,Task,LSP,NotebookEdit',
    '--no-session-persistence',
    '--disable-slash-commands',
    '--no-chrome',
    '--strict-mcp-config',
    '--mcp-config',
    EMPTY_MCP_CONFIG,
  ];
  const claudeModel = (settings.model || '').trim();
  if (claudeModel) args.push('--model', claudeModel);
  const { stdout } = await runCli(cmd, args, user, settings.cliTimeoutMs, job, spawnImpl);

  const resultText = claudeResultText(stdout);
  if (!resultText && stdout.trim()) {
    console.warn(
      '[parallel-reader] claude CLI returned unexpected output. length=',
      stdout.length,
      'head=',
      stdout.slice(0, 80),
    );
  }

  if (!resultText) {
    console.warn(
      '[parallel-reader] claude CLI returned no result. length=',
      stdout.length,
      'head=',
      stdout.slice(0, 80),
    );
    throw new Error(translate(settings, 'errorClaudeCliNoResult', { length: String(stdout.length) }));
  }

  return parseCardsJson(resultText, settings);
}

export async function summarizeViaCodex(
  system: string,
  user: string,
  settings: PluginSettings,
  job?: GenerationJob,
  spawnImpl?: typeof spawn,
): Promise<RawCard[]> {
  const cmd = resolveCliPath('codex', settings.cliPath);
  const combined = `<<SYSTEM>>\n${system}\n<<USER>>\n${user}\n\nOutput JSON directly with no explanation.`;
  // NOTE: do NOT pass --model. settings.model defaults to a Claude model name
  // (claude-sonnet-4-6), which would break Codex if passed verbatim. Codex
  // uses its own config.toml profile for model selection.
  const args = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-'];
  const { stdout } = await runCli(cmd, args, combined, settings.cliTimeoutMs, job, spawnImpl);
  return parseCardsJson(stdout, settings);
}
